"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ExternalLink } from "lucide-react";

import type { AdminNavGroup } from "@/types/admin";

import { cn } from "@/lib/utils/cn";

import { AdminIcon } from "./AdminIcons";

import logoMark from "../../../../public/brand/logo.png";

/** Counts resolved by the shell and shown as badges beside nav items. */
export interface NavBadges {
  lowStock: number;
  openOrders: number;
  pendingReviews: number;
}

/**
 * The admin sidebar.
 *
 * Entirely driven by `admin/navigation.json` — adding a section is a data edit,
 * not a component edit. Badge counts are resolved by the shell and passed in,
 * because the nav config can only name *which* count a row wants, not compute
 * it.
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
        {groups.map((group) => (
          <div key={group.id} className="mb-4 last:mb-0">
            <p className="px-2 pb-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-white/35">
              {group.heading}
            </p>

            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                // `startsWith` so a detail page keeps its section highlighted,
                // but the dashboard does not match every /admin/* route.
                const active =
                  pathname === item.href ||
                  (item.href !== "/admin/dashboard" && pathname.startsWith(`${item.href}/`));

                const badgeCount = item.badge ? badges[item.badge] : 0;

                /**
                 * Sub-sections appear only while their parent is in use.
                 *
                 * Keeping them collapsed the rest of the time stops the
                 * sidebar growing past a screenful, which is the point at
                 * which a navigation stops helping anyone.
                 */
                const inSection =
                  active || pathname === item.href || pathname.startsWith(`${item.href}/`);

                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-2.5 rounded-[3px] px-2 py-1.5 text-[0.8125rem] transition-colors",
                        active
                          ? "bg-copper-600 text-white"
                          : "text-white/70 hover:bg-white/8 hover:text-white",
                      )}
                    >
                      <AdminIcon name={item.icon} className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>

                      {badgeCount > 0 ? (
                        <span
                          className={cn(
                            "shrink-0 rounded-pill px-1.5 py-0.5 text-[0.625rem] font-medium tabular-nums",
                            active ? "bg-white/25 text-white" : "bg-white/12 text-white/80",
                          )}
                        >
                          {badgeCount > 99 ? "99+" : badgeCount}
                        </span>
                      ) : null}
                    </Link>

                    {item.children && inSection ? (
                      <ul className="mt-0.5 ml-[1.45rem] flex flex-col gap-0.5 border-l border-white/10 pl-2">
                        {item.children.map((child) => {
                          const childActive =
                            pathname === child.href || pathname.startsWith(`${child.href}/`);
                          return (
                            <li key={child.id}>
                              <Link
                                href={child.href}
                                onClick={onNavigate}
                                aria-current={childActive ? "page" : undefined}
                                className={cn(
                                  "block truncate rounded-[3px] px-2 py-1 text-[0.75rem] transition-colors",
                                  childActive
                                    ? "bg-white/12 text-white"
                                    : "text-white/55 hover:bg-white/8 hover:text-white",
                                )}
                              >
                                {child.label}
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
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
