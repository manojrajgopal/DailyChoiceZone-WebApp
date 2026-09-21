"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, LogOut, Package, User } from "lucide-react";

import type { NavItem } from "@/types";

import { Drawer } from "@/components/ui/Dialog";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";

/**
 * The mobile navigation drawer.
 *
 * The desktop mega menu's columns become nested accordions here rather than a
 * second menu system — same `navigation.json`, different disclosure. Only one
 * department is open at a time, which keeps the list short enough to scan on
 * a phone.
 */
export function MobileNav({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: NavItem[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { user, isSignedIn, signOut } = useSession();

  const close = () => onOpenChange(false);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Menu" side="left">
      <nav aria-label="Main">
        <ul className="flex flex-col">
          {items.map((item) => {
            const hasChildren = Boolean(item.columns?.length);
            const isExpanded = expanded === item.id;

            return (
              <li key={item.id} className="border-b border-ink-100">
                <div className="flex items-stretch">
                  <Link
                    href={item.href}
                    onClick={close}
                    className={cn(
                      "flex-1 px-4 py-3.5 font-display text-base transition-colors",
                      item.highlight ? "text-clay-500" : "text-ink",
                    )}
                  >
                    {item.label}
                  </Link>

                  {hasChildren ? (
                    <button
                      type="button"
                      onClick={() => setExpanded(isExpanded ? null : item.id)}
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? "Collapse" : "Expand"} ${item.label}`}
                      className="px-4 text-ink-500 transition-colors hover:text-ink"
                    >
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 transition-transform duration-200",
                          isExpanded && "rotate-180",
                        )}
                        strokeWidth={1.5}
                      />
                    </button>
                  ) : null}
                </div>

                {hasChildren && isExpanded ? (
                  <div className="bg-cream-deep px-4 pb-4 pt-1">
                    {item.columns?.map((column) => (
                      <div key={column.heading} className="mt-3 first:mt-0">
                        <p className="label-wide mb-2 text-copper-700">{column.heading}</p>
                        <ul className="flex flex-col gap-0.5">
                          {column.links.map((link) => (
                            <li key={`${column.heading}-${link.href}-${link.label}`}>
                              <Link
                                href={link.href}
                                onClick={close}
                                className="block py-1.5 text-sm text-ink-700 transition-colors hover:text-ink"
                              >
                                {link.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>

      {/* ----------------------------------------------------- account block */}
      <div className="mt-2 border-t border-ink-200 px-4 py-4">
        {isSignedIn && user ? (
          <div className="flex flex-col gap-1">
            <p className="label-wide mb-2 text-ink-500">
              Hello, {user.firstName}
            </p>
            <Link
              href="/account"
              onClick={close}
              className="flex items-center gap-2.5 py-2 text-sm text-ink transition-colors hover:text-copper-700"
            >
              <User className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
              My account
            </Link>
            <Link
              href="/account/orders"
              onClick={close}
              className="flex items-center gap-2.5 py-2 text-sm text-ink transition-colors hover:text-copper-700"
            >
              <Package className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
              My orders
            </Link>
            <button
              type="button"
              onClick={() => {
                void signOut();
                close();
              }}
              className="flex items-center gap-2.5 py-2 text-left text-sm text-ink transition-colors hover:text-copper-700"
            >
              <LogOut className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
              Sign out
            </button>
          </div>
        ) : (
          <Link
            href="/account"
            onClick={close}
            className="flex h-11 items-center justify-center rounded-control bg-ink label-wide text-cream transition-colors hover:bg-ink-700"
          >
            Sign in / Register
          </Link>
        )}
      </div>
    </Drawer>
  );
}
