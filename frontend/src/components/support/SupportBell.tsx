"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";

import { listMyNotifications, markMyNotificationsRead, type CustomerNotification } from "@/services/supportService";

import { useConfirmedCustomer } from "@/hooks/useSession";
import { usePoll } from "@/hooks/usePoll";
import { cn } from "@/lib/utils/cn";
import { formatAgo } from "@/lib/support/format";

/**
 * The customer's notifications: orders, payments, refunds and returns,
 * support replies, stock and price alerts, questions answered, gift cards,
 * store credit and reward points — everything we email them about appears
 * here too. Shown only to a signed-in customer whose session the server has
 * confirmed, and refreshed on navigation and every minute.
 */
export function SupportBell({ className }: { className: string }) {
  const signedIn = useConfirmedCustomer();
  const pathname = usePathname();
  const [items, setItems] = useState<CustomerNotification[]>([]);
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    listMyNotifications()
      .then(setItems)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (signedIn) load();
  }, [signedIn, pathname, load]);
  usePoll(load, 60_000, signedIn);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!signedIn) return null;
  const unread = items.filter((item) => !item.read).length;

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Notifications, ${unread} unread`}
        aria-expanded={open}
        className={className}
      >
        <Bell className="h-5 w-5" strokeWidth={1.5} />
        {unread > 0 ? (
          <span className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-copper-600 px-1 text-[0.5625rem] font-medium tabular-nums text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-ink-200 bg-shell shadow-overlay">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
            <p className="label-wide text-ink">Notifications</p>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => {
                  void markMyNotificationsRead().catch(() => undefined);
                  setItems((list) => list.map((item) => ({ ...item, read: true })));
                }}
                className="text-xs text-copper-700 underline underline-offset-2 hover:text-ink"
              >
                Mark all read
              </button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-500">No updates yet.</p>
          ) : (
            <ul className="scroll-panel max-h-96 overflow-y-auto">
              {items.map((item) => (
                <li key={item.id} className="border-b border-ink-100 last:border-0">
                  <Link
                    href={item.href || "/account"}
                    onClick={() => setOpen(false)}
                    className={cn("block px-4 py-3 transition-colors hover:bg-cream-deep", !item.read && "bg-copper-50/60")}
                  >
                    <p className="flex items-start gap-2 text-sm font-medium text-ink">
                      {!item.read ? <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill bg-copper-600" /> : null}
                      <span className="min-w-0">{item.title}</span>
                    </p>
                    {item.body ? <p className="mt-0.5 line-clamp-2 pl-3.5 text-xs text-ink-500">{item.body}</p> : null}
                    <p className="mt-1 pl-3.5 text-[0.6875rem] text-ink-400">{formatAgo(item.at)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 border-t border-ink-100 text-center text-xs font-medium text-copper-700">
            <Link href="/account/orders" onClick={() => setOpen(false)} className="px-4 py-3 hover:bg-cream-deep">
              Your orders
            </Link>
            <Link href="/account/settings" onClick={() => setOpen(false)} className="border-l border-ink-100 px-4 py-3 hover:bg-cream-deep">
              Email preferences
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
