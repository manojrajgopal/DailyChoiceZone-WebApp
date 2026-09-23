"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bell, Check, CreditCard, FileText, LogOut, Menu, Package, Search, ShoppingCart, Undo2, User, Users } from "lucide-react";

import type { AdminNotification } from "@/types/admin";

import { useAdminSession } from "@/hooks/useAdminSession";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  search,
  EMPTY_SEARCH_RESULTS,
  type AdminSearchResults,
} from "@/services/admin/adminSearchService";

const EMPTY_RESULTS: AdminSearchResults = EMPTY_SEARCH_RESULTS;

const RESULT_ICONS = {
  product: Package,
  order: ShoppingCart,
  customer: Users,
  invoice: FileText,
  payment: CreditCard,
  refund: Undo2,
} as const;

/**
 * The admin top bar: menu toggle, global search, notifications and profile.
 *
 * Search spans products, orders, customers and billing, because an
 * administrator arrives holding an identifier — an order number from an email,
 * a SKU from a supplier, a transaction reference from a bank statement — and
 * should not have to work out which list owns it first.
 */
export function AdminHeader({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const router = useRouter();
  const { user, signOut } = useAdminSession();

  const [term, setTerm] = useState("");
  const [results, setResults] = useState<AdminSearchResults>(EMPTY_RESULTS);
  const [searchOpen, setSearchOpen] = useState(false);

  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const searchRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  /* --------------------------------------------------------- search */

  // Debounced: every keystroke querying three collections is wasteful now and
  // would be three API calls later.
  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      setResults(EMPTY_RESULTS);
      return;
    }

    let active = true;
    const timer = setTimeout(() => {
      search(trimmed)
        .then((found) => {
          if (active) setResults(found);
        })
        .catch(() => {
          if (active) setResults(EMPTY_RESULTS);
        });
    }, 180);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [term]);

  /* -------------------------------------------------- notifications */

  useEffect(() => {
    let active = true;
    listNotifications()
      .then((list) => {
        if (active) setNotifications(list);
      })
      .catch(() => {
        if (active) setNotifications([]);
      });
    return () => {
      active = false;
    };
  }, []);

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

  const go = (href: string) => {
    setSearchOpen(false);
    setTerm("");
    router.push(href);
  };

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
          Search products, orders and customers
        </label>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <input
          id="admin-search"
          type="search"
          value={term}
          placeholder="Search products, orders, customers"
          autoComplete="off"
          onChange={(event) => {
            setTerm(event.target.value);
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          className="h-9 w-full rounded-[3px] border border-admin-border bg-admin-raised pl-8 pr-2.5 text-[0.8125rem] text-admin-ink placeholder:text-admin-faint focus:border-copper-500 focus:bg-admin-surface"
        />

        {searchOpen && term.trim().length >= 2 ? (
          <div className="absolute left-0 right-0 top-11 z-40 max-h-[70vh] overflow-y-auto rounded-[3px] border border-admin-border bg-admin-surface shadow-raised">
            {results.total === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-admin-muted">
                Nothing matches &ldquo;{term.trim()}&rdquo;.
              </p>
            ) : (
              <>
                {(
                  [
                    ["Products", results.products],
                    ["Orders", results.orders],
                    ["Customers", results.customers],
                    ["Invoices", results.invoices],
                    ["Payments", results.payments],
                    ["Refunds", results.refunds],
                  ] as const
                ).map(([heading, group]) =>
                  group.length === 0 ? null : (
                    <div key={heading} className="border-b border-admin-border last:border-0">
                      <p className="px-3 pb-1 pt-2.5 text-[0.625rem] font-medium uppercase tracking-[0.12em] text-admin-faint">
                        {heading}
                      </p>
                      <ul>
                        {group.map((result) => {
                          const Icon = RESULT_ICONS[result.kind];
                          return (
                            <li key={`${result.kind}-${result.id}`}>
                              <button
                                type="button"
                                onClick={() => go(result.href)}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-admin-raised"
                              >
                                <Icon
                                  className="h-3.5 w-3.5 shrink-0 text-admin-faint"
                                  strokeWidth={1.75}
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-xs text-admin-ink">
                                    {result.title}
                                  </span>
                                  <span className="block truncate text-[0.625rem] text-admin-muted">
                                    {result.subtitle}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ),
                )}
              </>
            )}
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

            <ul className="max-h-80 overflow-y-auto">
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
