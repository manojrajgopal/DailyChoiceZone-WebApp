"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Bell, Check, Loader2, LogOut, Menu, Search, User } from "lucide-react";

import type { AdminNotification } from "@/types/admin";

import { useAdminSession } from "@/hooks/useAdminSession";
import { usePoll } from "@/hooks/usePoll";
import { adminLookupHref } from "@/lib/lookup/entities";
import { lookupErrorMessage } from "@/lib/lookup/errors";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  search,
  EMPTY_SEARCH_RESULTS,
  MIN_SEARCH_LENGTH,
  type AdminSearchResult,
  type AdminSearchResults,
} from "@/services/admin/adminSearchService";

const EMPTY_RESULTS: AdminSearchResults = EMPTY_SEARCH_RESULTS;

/**
 * The admin top bar: menu toggle, global ID search, notifications and profile.
 *
 * The search finds any record by its ID — an order number from an email, a
 * SKU from a supplier, a transaction reference from a bank statement — without
 * first working out which list owns it. IDs only: a name finds nothing (see
 * docs/id-lookup.md). Choosing an ID opens its preview.
 */
export function AdminHeader({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const router = useRouter();
  const { user, signOut } = useAdminSession();

  const [term, setTerm] = useState("");
  const [found, setFound] = useState<{ term: string; results: AdminSearchResults; error: unknown } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(-1);
  const searchIds = useId();

  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const searchRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  /* --------------------------------------------------------- search */

  // Debounced, and a request made stale by newer typing is aborted rather
  // than ignored, so an old answer can never land on top of a newer one.
  const trimmedTerm = term.trim();
  const searching = trimmedTerm.length >= MIN_SEARCH_LENGTH;
  useEffect(() => {
    if (!searching) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(trimmedTerm, 3, { signal: controller.signal })
        .then((results) => {
          if (!controller.signal.aborted) setFound({ term: trimmedTerm, results, error: null });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setFound({ term: trimmedTerm, results: EMPTY_RESULTS, error });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searching, trimmedTerm]);

  const current = searching && found?.term === trimmedTerm ? found : null;
  const results = current?.results ?? EMPTY_RESULTS;
  const isSearching = searching && !current;
  const flat: AdminSearchResult[] = results.groups.flatMap((group) => group.items);
  const listOpen = searchOpen && searching;

  /* -------------------------------------------------- notifications */

  // Re-read every minute (while the tab is visible), so a ticket assigned to
  // this administrator or an SLA breach shows up without a reload.
  const [notificationTick, setNotificationTick] = useState(0);
  usePoll(() => setNotificationTick((tick) => tick + 1), 60_000);

  useEffect(() => {
    let active = true;
    listNotifications()
      .then((list) => {
        if (active) setNotifications(list);
      })
      .catch(() => {
        // A failed refresh keeps what is already shown.
        if (active && notificationTick === 0) setNotifications([]);
      });
    return () => {
      active = false;
    };
  }, [notificationTick]);

  const unread = notifications.filter((notification) => !notification.read).length;

  /* ------------------------------------------- dismiss on outside click */

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!searchRef.current?.contains(target)) setSearchOpen(false);
      if (!bellRef.current?.contains(target)) setBellOpen(false);
      if (!profileRef.current?.contains(target)) setProfileOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSearchOpen(false);
      setBellOpen(false);
      setProfileOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const go = (result: AdminSearchResult) => {
    setSearchOpen(false);
    setTerm("");
    setActiveResult(-1);
    router.push(adminLookupHref(result.entity, result.id));
  };

  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length === 0) return;
      setSearchOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveResult((index) => (index + step + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // Enter with nothing highlighted opens the only match, if there is one.
      const chosen = flat[activeResult] ?? (flat.length === 1 ? flat[0] : undefined);
      if (chosen) go(chosen);
    }
  };

  const listId = `${searchIds}-results`;
  const optionId = (index: number) => `${searchIds}-result-${index}`;
  let searchStatus = "";
  if (listOpen) {
    if (isSearching) searchStatus = "Searching IDs…";
    else if (current?.error) searchStatus = lookupErrorMessage(current.error, { idLabel: "ID" });
    else if (results.total === 0) searchStatus = "No matching IDs found.";
    else searchStatus = `${results.total} matching ${results.total === 1 ? "ID" : "IDs"}.`;
  }

  const iconButton =
    "relative inline-flex h-9 w-9 items-center justify-center rounded-[3px] text-admin-ink transition-colors hover:bg-admin-raised";

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-admin-border bg-admin-surface px-3 sm:px-4">
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open navigation"
        className={cn(iconButton, "lg:hidden")}
      >
        <Menu className="h-5 w-5" strokeWidth={1.75} />
      </button>

      {/* ------------------------------------------------------- search */}
      <div ref={searchRef} className="relative min-w-0 flex-1 max-w-md">
        <label htmlFor="admin-search" className="sr-only">
          Search any record by its ID
        </label>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          id="admin-search"
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={listOpen && flat.length > 0}
          aria-controls={listId}
          aria-activedescendant={listOpen && flat[activeResult] ? optionId(activeResult) : undefined}
          aria-describedby={`${searchIds}-status`}
          value={term}
          placeholder="Search by ID… (DCZ10241, PRD001, CUS001)"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setTerm(event.target.value);
            setSearchOpen(true);
            setActiveResult(-1);
          }}
          onFocus={() => setSearchOpen(true)}
          onKeyDown={onSearchKey}
          className="h-9 w-full rounded-[3px] border border-admin-border bg-admin-raised pl-8 pr-8 font-mono text-[0.8125rem] text-admin-ink placeholder:font-sans placeholder:text-admin-faint focus:border-copper-500 focus:bg-admin-surface"
        />
        {isSearching ? (
          <Loader2
            className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-admin-faint"
            aria-hidden="true"
          />
        ) : null}
        <p id={`${searchIds}-status`} role="status" aria-live="polite" className="sr-only">
          {searchStatus}
        </p>

        {listOpen ? (
          <div className="scroll-panel absolute left-0 right-0 top-11 z-40 max-h-[70vh] overflow-y-auto rounded-[3px] border border-admin-border bg-admin-surface shadow-raised">
            {flat.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-admin-muted">{searchStatus}</p>
            ) : (
              <ul id={listId} role="listbox" aria-label="Matching IDs">
                {results.groups.map((group) => (
                  <li key={group.entity} role="presentation" className="border-b border-admin-border last:border-0">
                    <p className="px-3 pb-1 pt-2.5 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-admin-faint">
                      {group.idLabel}
                    </p>
                    <ul role="group" aria-label={group.idLabel}>
                      {group.items.map((result) => {
                        const index = flat.indexOf(result);
                        return (
                          <li
                            key={`${result.entity}-${result.id}`}
                            id={optionId(index)}
                            role="option"
                            aria-selected={index === activeResult}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => go(result)}
                            onMouseEnter={() => setActiveResult(index)}
                            className={cn(
                              "flex cursor-pointer items-baseline justify-between gap-2.5 px-3 py-2 transition-colors hover:bg-admin-raised",
                              index === activeResult && "bg-admin-raised",
                            )}
                          >
                            <span className="min-w-0 truncate text-xs text-admin-ink">
                              <span className="text-admin-muted">{result.label} — </span>
                              <span className="font-mono">{result.id}</span>
                            </span>
                            {result.match ? (
                              <span className="shrink-0 truncate font-mono text-[0.625rem] text-admin-muted">
                                matched {result.match}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/admin/lookup"
              onClick={() => setSearchOpen(false)}
              className="block border-t border-admin-border px-3 py-2 text-[0.6875rem] text-copper-600 hover:bg-admin-raised"
            >
              Open the ID lookup
            </Link>
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------ notifications */}
      <div ref={bellRef} className="relative ml-auto">
        <button
          type="button"
          onClick={() => setBellOpen((open) => !open)}
          aria-label={`Notifications, ${unread} unread`}
          aria-expanded={bellOpen}
          className={iconButton}
        >
          <Bell className="h-4.5 w-4.5" strokeWidth={1.75} />
          {unread > 0 ? (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-[#c23434] px-1 text-[0.5625rem] font-medium leading-none text-white tabular-nums"
            >
              {unread}
            </span>
          ) : null}
        </button>

        {bellOpen ? (
          <div className="absolute right-0 top-11 z-40 w-80 max-w-[calc(100vw-1.5rem)] rounded-[3px] border border-admin-border bg-admin-surface shadow-raised">
            <div className="flex items-center justify-between border-b border-admin-border px-3 py-2">
              <p className="text-xs font-semibold text-admin-ink">Notifications</p>
              {unread > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    void markAllNotificationsRead();
                    setNotifications((list) => list.map((n) => ({ ...n, read: true })));
                  }}
                  className="inline-flex items-center gap-1 text-[0.625rem] text-copper-700 hover:text-admin-ink"
                >
                  <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
                  Mark all read
                </button>
              ) : null}
            </div>

            <ul className="scroll-panel max-h-80 overflow-y-auto">
              {notifications.length === 0 ? (
                <li className="px-3 py-6 text-center text-xs text-admin-muted">
                  Nothing needs your attention.
                </li>
              ) : (
                notifications.map((notification) => (
                  <li key={notification.id} className="border-b border-admin-border last:border-0">
                    <Link
                      href={notification.href}
                      onClick={() => {
                        void markNotificationRead(notification.id);
                        setNotifications((list) =>
                          list.map((n) => (n.id === notification.id ? { ...n, read: true } : n)),
                        );
                        setBellOpen(false);
                      }}
                      className={cn(
                        "block px-3 py-2.5 transition-colors hover:bg-admin-raised",
                        !notification.read && "bg-copper-50/60",
                      )}
                    >
                      <p className="flex items-start gap-2 text-xs font-medium text-admin-ink">
                        {!notification.read ? (
                          <span
                            aria-hidden="true"
                            className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill bg-copper-600"
                          />
                        ) : null}
                        <span className="min-w-0">{notification.title}</span>
                      </p>
                      <p className="mt-0.5 pl-3.5 text-[0.625rem] leading-relaxed text-admin-muted">
                        {notification.body}
                      </p>
                      <p className="mt-1 pl-3.5 text-[0.5625rem] text-admin-faint">
                        {formatDate(notification.at)}
                      </p>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------------ profile */}
      <div ref={profileRef} className="relative">
        <button
          type="button"
          onClick={() => setProfileOpen((open) => !open)}
          aria-label="Admin profile menu"
          aria-expanded={profileOpen}
          className="flex h-9 items-center gap-2 rounded-[3px] px-1.5 transition-colors hover:bg-admin-raised"
        >
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-copper-600 text-[0.625rem] font-semibold text-white">
            {user?.avatarInitials || "DC"}
          </span>
          <span className="hidden min-w-0 text-left sm:block">
            <span className="block truncate text-xs font-medium text-admin-ink">
              {user?.name ?? "Admin"}
            </span>
            <span className="block truncate text-[0.625rem] capitalize text-admin-muted">
              {user?.role.replace("-", " ") ?? ""}
            </span>
          </span>
        </button>

        {profileOpen ? (
          <div className="absolute right-0 top-11 z-40 w-52 rounded-[3px] border border-admin-border bg-admin-surface py-1 shadow-raised">
            <Link
              href="/admin/settings/profile"
              onClick={() => setProfileOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 text-xs text-admin-ink transition-colors hover:bg-admin-raised"
            >
              <User className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              My profile
            </Link>
            <button
              type="button"
              onClick={() => {
                setProfileOpen(false);
                void signOut();
                router.push("/admin/login");
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-admin-ink transition-colors hover:bg-admin-raised"
            >
              <LogOut className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
