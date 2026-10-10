"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, ExternalLink } from "lucide-react";

import type { AdminNavGroup, AdminNavItem } from "@/types/admin";

import { cn } from "@/lib/utils/cn";

import { AdminIcon } from "./AdminIcons";

import logoMark from "../../../../public/brand/logo.png";

/** Counts resolved by the shell and shown as badges beside nav items. */
export interface NavBadges {
  lowStock: number;
  openOrders: number;
  pendingReviews: number;
  openReturns: number;
  openTickets: number;
  pendingQuestions: number;
  referralsInReview: number;
  failedNotifications: number;
  waitingCustomers: number;
}

/**
 * The counts a sidebar link can show.
 *
 * Each is resolved by a function in `AdminShell`, so this is the whole set —
 * the navigation editor offers these and nothing else, because a fourth name
 * would save fine and then render no chip.
 */
export const BADGE_NAMES: (keyof NavBadges)[] = ["openOrders", "openReturns", "openTickets", "lowStock", "pendingReviews", "pendingQuestions", "referralsInReview", "failedNotifications", "waitingCustomers"];

/** Which groups and folders the person opened or closed, remembered per browser. */
export const OPEN_KEY = "dcz-admin-nav-open";

/** Whether `pathname` is `href` or a page under it. The dashboard matches only itself. */
function matches(href: string, pathname: string): boolean {
  if (!href) return false;
  return pathname === href || (href !== "/admin/dashboard" && pathname.startsWith(`${href}/`));
}

function flatten(items: AdminNavItem[]): AdminNavItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
}

/** The href of the one link the current page belongs to (the longest match), or "". */
export function currentHref(groups: AdminNavGroup[], pathname: string): string {
  let best = "";
  for (const item of flatten(groups.flatMap((group) => group.items))) {
    if (matches(item.href, pathname) && item.href.length > best.length) best = item.href;
  }
  return best;
}

function contains(item: AdminNavItem, current: string): boolean {
  return !!current && (item.href === current || (item.children ?? []).some((child) => contains(child, current)));
}

/** The group and folder keys that must be open for `current` to be visible. */
function openKeysFor(groups: AdminNavGroup[], current: string): string[] {
  const keys: string[] = [];
  const walk = (items: AdminNavItem[]) => {
    for (const item of items) {
      if (item.children?.length && contains(item, current)) {
        keys.push(`item:${item.id}`);
        walk(item.children);
      }
    }
  };
  for (const group of groups) {
    if (group.items.some((item) => contains(item, current))) {
      keys.push(`group:${group.id}`);
      walk(group.items);
    }
  }
  return keys;
}

/** A link's own count, plus everything under it: a closed folder still shows what's waiting inside. */
function badgeTotal(item: AdminNavItem, badges: NavBadges): number {
  const own = item.badge ? (badges[item.badge as keyof NavBadges] ?? 0) : 0;
  return own + (item.children ?? []).reduce((sum, child) => sum + badgeTotal(child, badges), 0);
}

function Badge({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-pill px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums",
        active ? "bg-white/25 text-white" : "bg-white/12 text-white/80",
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * One row, and whatever is nested under it.
 *
 * A **folder** (no href) is a button that opens and closes. A **link** with
 * sub-links shows them while its section is open (the person is on it or
 * under it, or opened it with the chevron). Nesting is indented with a rule
 * on the left, a little smaller at each level.
 */
function NavEntry({
  item,
  depth,
  current,
  badges,
  isOpen,
  toggle,
  onNavigate,
}: {
  item: AdminNavItem;
  depth: number;
  current: string;
  badges: NavBadges;
  isOpen: (key: string, containsCurrent: boolean) => boolean;
  toggle: (key: string, open: boolean) => void;
  onNavigate?: () => void;
}) {
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  const key = `item:${item.id}`;
  const inside = contains(item, current);
  const open = hasChildren && isOpen(key, inside);
  const active = !!item.href && item.href === current;
  const nested = depth > 0;

  const rowClass = cn(
    "flex w-full items-center gap-2.5 rounded-[3px] px-2 text-left transition-colors",
    nested ? "py-1 text-[0.78125rem]" : "py-1.5 text-[0.8125rem]",
    active
      ? "bg-copper-600 text-white"
      : inside && !item.href
        ? "text-white"
        : "text-white/70 hover:bg-white/8 hover:text-white",
  );
  // Closed, a row carries its children's counts; open, each child shows its own.
  const count = open ? (item.badge ? (badges[item.badge as keyof NavBadges] ?? 0) : 0) : badgeTotal(item, badges);
  const chevron = (
    <ChevronRight
      className={cn("h-3.5 w-3.5 shrink-0 text-white/45 transition-transform", open && "rotate-90")}
      strokeWidth={2}
      aria-hidden="true"
    />
  );

  return (
    <li>
      {item.href ? (
        <div className="flex items-center">
          <Link
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(rowClass, "min-w-0 flex-1")}
          >
            <AdminIcon name={item.icon} className={cn("shrink-0", nested ? "h-3.5 w-3.5" : "h-4 w-4")} />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <Badge count={count} active={active} />
          </Link>
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggle(key, open)}
              aria-expanded={open}
              aria-label={`${open ? "Hide" : "Show"} ${item.label} pages`}
              className="ml-0.5 inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-[3px] hover:bg-white/8"
            >
              {chevron}
            </button>
          ) : null}
        </div>
      ) : (
        <button type="button" onClick={() => toggle(key, open)} aria-expanded={open} className={rowClass}>
          <AdminIcon name={item.icon} className={cn("shrink-0", nested ? "h-3.5 w-3.5" : "h-4 w-4")} />
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <Badge count={count} active={false} />
          {chevron}
        </button>
      )}

      {open ? (
        <ul className="mt-0.5 ml-[1.1rem] flex flex-col gap-0.5 border-l border-white/10 pl-1.5">
          {children.map((child) => (
            <NavEntry
              key={child.id}
              item={child}
              depth={depth + 1}
              current={current}
              badges={badges}
              isOpen={isOpen}
              toggle={toggle}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The admin sidebar.
 *
 * Driven by the navigation the backend serves (`site.admin_navigation`): groups
 * of links and folders of links, nested. Groups and folders open and close; the
 * ones holding the current page open by themselves, and what the person opens
 * or closes is remembered. Badge counts are resolved by the shell and passed
 * in, because the nav config can only name *which* count a row wants.
 */
export function AdminSidebar({
  groups,
  badges,
  onNavigate,
}: {
  groups: AdminNavGroup[];
  badges: NavBadges;
  /** Called on any link click, so the mobile drawer can close itself. */
  onNavigate?: () => void;
}) {
  const pathname = usePathname() ?? "";
  // The one link the current page belongs to: the longest matching path, so
  // /admin/settings/site lights up Site and not Store settings as well.
  const current = useMemo(() => currentHref(groups, pathname), [groups, pathname]);

  // What the person opened or closed. Anything they haven't touched follows the
  // current page: its group and folder open, the rest closed.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(OPEN_KEY) ?? "{}");
      if (saved && typeof saved === "object") setOverrides(saved as Record<string, boolean>);
    } catch {
      // Private window or blocked storage: start from the defaults.
    }
  }, []);

  // Arriving on a page reopens whatever was closed over it, so the current link is never hidden.
  useEffect(() => {
    const over = openKeysFor(groups, current);
    setOverrides((previous) => {
      if (!over.some((key) => previous[key] === false)) return previous;
      const next = { ...previous };
      for (const key of over) delete next[key];
      return next;
    });
  }, [groups, current]);

  const isOpen = (key: string, containsCurrent: boolean) => overrides[key] ?? containsCurrent;
  const toggle = (key: string, open: boolean) => {
    setOverrides((previous) => {
      const next = { ...previous, [key]: !open };
      try {
        window.localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        // Not remembered, but still works for this visit.
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col bg-admin-ink text-white/80">
      {/* --------------------------------------------------------- brand */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-white/10 px-4">
        <Image
          src={logoMark}
          alt=""
          aria-hidden="true"
          className="h-7 w-7 shrink-0 rounded-pill bg-white object-contain"
          sizes="28px"
        />
        <span className="min-w-0">
          <span className="block truncate text-[0.8125rem] font-semibold leading-tight text-white">
            Daily Choice Zone
          </span>
          <span className="block text-[0.625rem] uppercase tracking-[0.18em] text-white/45">
            Admin
          </span>
        </span>
      </div>

      {/* ----------------------------------------------------------- nav */}
      <nav aria-label="Admin sections" className="scroll-dark min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {groups.map((group) => {
          const open = isOpen(`group:${group.id}`, group.items.some((item) => contains(item, current)));
          return (
            <div key={group.id} className="mb-1.5 last:mb-0">
              <button
                type="button"
                onClick={() => toggle(`group:${group.id}`, open)}
                aria-expanded={open}
                className="flex w-full items-center gap-1 rounded-[3px] px-2 py-1.5 text-left text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/40 transition-colors hover:text-white/70"
              >
                <span className="min-w-0 flex-1 truncate">{group.heading}</span>
                <ChevronRight
                  className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </button>

              {open ? (
                <ul className="mb-2 flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <NavEntry
                      key={item.id}
                      item={item}
                      depth={0}
                      current={current}
                      badges={badges}
                      isOpen={isOpen}
                      toggle={toggle}
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </nav>

      {/* ------------------------------------------------- storefront link */}
      <div className="shrink-0 border-t border-white/10 p-2">
        <Link
          href="/"
          className="flex items-center gap-2.5 rounded-[3px] px-2 py-1.5 text-[0.8125rem] text-white/60 transition-colors hover:bg-white/8 hover:text-white"
        >
          <ExternalLink className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          View storefront
        </Link>
      </div>
    </div>
  );
}
