"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, LogOut, Package, User } from "lucide-react";

import type { NavColumn, NavItem } from "@/types";

import { Drawer } from "@/components/ui/Dialog";
import { useSession } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";

/**
 * The mobile navigation drawer — a two-level drill-down.
 *
 * Level one lists the departments and nothing else, so the whole store fits on
 * one screen. Choosing a department slides in its own panel: a way back, a
 * "Shop all" link, and each group (Clothing, Shoes…) as a collapsible section
 * with its links indented beneath it. One long list of every heading and link,
 * which is what an accordion of the desktop mega menu produced, is the thing
 * this replaces.
 *
 * The panel that is off screen is `inert`, so neither a keyboard nor a screen
 * reader can wander into it. The slide respects reduced-motion settings.
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
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const { user, isSignedIn, signOut } = useSession();
  const root = useRef<HTMLDivElement>(null);

  const department = items.find((item) => item.id === departmentId) ?? null;
  const close = () => onOpenChange(false);

  // Every visit starts at the top level.
  useEffect(() => {
    if (!open) setDepartmentId(null);
  }, [open]);

  // A new panel starts at its top, not wherever the last one was scrolled to.
  const scrollToTop = () => {
    root.current?.closest(".scroll-panel")?.scrollTo({ top: 0 });
  };

  const openDepartment = (id: string) => {
    setDepartmentId(id);
    scrollToTop();
  };

  const back = () => {
    setDepartmentId(null);
    scrollToTop();
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Menu" side="left">
      <div ref={root} className="relative overflow-hidden">
        <div
          className={cn(
            "flex w-[200%] items-start transition-transform duration-300 ease-brand motion-reduce:transition-none",
            department ? "-translate-x-1/2" : "translate-x-0",
          )}
        >
          {/* ---------------------------------------------- level one */}
          <div className="w-1/2 shrink-0" inert={department ? true : undefined}>
            <nav aria-label="Departments">
              <ul className="flex flex-col">
                {items.map((item) => {
                  const hasChildren = Boolean(item.columns?.length);
                  const labelClass = cn(
                    "font-display text-[1.0625rem]",
                    item.highlight ? "text-clay-500" : "text-ink",
                  );

                  return (
                    <li key={item.id} className="border-b border-ink-100">
                      {hasChildren ? (
                        <button
                          type="button"
                          onClick={() => openDepartment(item.id)}
                          aria-label={`${item.label} — see categories`}
                          className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-cream-deep"
                        >
                          <span className={labelClass}>{item.label}</span>
                          <ChevronRight className="h-4 w-4 text-ink-400" strokeWidth={1.5} aria-hidden="true" />
                        </button>
                      ) : (
                        <Link
                          href={item.href}
                          onClick={close}
                          className="flex items-center justify-between px-5 py-4 transition-colors hover:bg-cream-deep"
                        >
                          <span className={labelClass}>{item.label}</span>
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </nav>

            <AccountBlock
              signedIn={isSignedIn && Boolean(user)}
              firstName={user?.firstName ?? ""}
              onNavigate={close}
              onSignOut={() => {
                void signOut();
                close();
              }}
            />
          </div>

          {/* ---------------------------------------------- level two */}
          <div className="w-1/2 shrink-0" inert={department ? undefined : true}>
            {department ? (
              <DepartmentPanel department={department} onBack={back} onNavigate={close} />
            ) : null}
          </div>
        </div>
      </div>
    </Drawer>
  );
}

function DepartmentPanel({
  department,
  onBack,
  onNavigate,
}: {
  department: NavItem;
  onBack: () => void;
  onNavigate: () => void;
}) {
  // The first group open by default: the most-shopped one is one tap away,
  // and the rest are a glance at their headings.
  const [openGroup, setOpenGroup] = useState<string | null>(
    department.columns?.[0]?.heading ?? null,
  );

  return (
    <nav aria-label={department.label}>
      <div className="flex items-center gap-1 border-b border-ink-100 px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-10 items-center gap-1 rounded-control px-2 text-sm text-ink-600 transition-colors hover:bg-cream-deep hover:text-ink"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          All departments
        </button>
      </div>

      <div className="px-5 pb-2 pt-5">
        <h2 className="font-display text-2xl text-ink">{department.label}</h2>
        <Link
          href={department.href}
          onClick={onNavigate}
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-copper-700 transition-colors hover:text-ink"
        >
          Shop all {department.label}
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        </Link>
      </div>

      <ul className="mt-3 flex flex-col border-t border-ink-100">
        {(department.columns ?? []).map((column) => (
          <Group
            key={column.heading}
            column={column}
            isOpen={openGroup === column.heading}
            onToggle={() =>
              setOpenGroup((current) => (current === column.heading ? null : column.heading))
            }
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    </nav>
  );
}

function Group({
  column,
  isOpen,
  onToggle,
  onNavigate,
}: {
  column: NavColumn;
  isOpen: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const id = `mobile-nav-${column.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <li className="border-b border-ink-100">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={id}
        className="flex w-full items-center justify-between px-5 py-3.5 text-left transition-colors hover:bg-cream-deep"
      >
        <span className="text-[0.9375rem] font-medium text-ink">{column.heading}</span>
        <span className="flex items-center gap-2 text-ink-400">
          <span className="text-xs tabular-nums">{column.links.length}</span>
          <ChevronDown
            className={cn("h-4 w-4 transition-transform duration-200", isOpen && "rotate-180")}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </span>
      </button>

      {isOpen ? (
        <ul id={id} className="mb-3 ml-5 mr-5 border-l border-ink-200">
          {column.links.map((link) => (
            <li key={`${link.href}-${link.label}`}>
              <Link
                href={link.href}
                onClick={onNavigate}
                className="-ml-px flex min-h-10 items-center border-l-2 border-transparent pl-4 text-sm text-ink-700 transition-colors hover:border-copper-500 hover:text-ink"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function AccountBlock({
  signedIn,
  firstName,
  onNavigate,
  onSignOut,
}: {
  signedIn: boolean;
  firstName: string;
  onNavigate: () => void;
  onSignOut: () => void;
}) {
  return (
    <div className="mt-2 border-t border-ink-200 px-5 py-5">
      {signedIn ? (
        <div className="flex flex-col gap-1">
          <p className="label-wide mb-2 text-ink-500">Hello, {firstName}</p>
          <Link
            href="/account"
            onClick={onNavigate}
            className="flex min-h-10 items-center gap-2.5 text-sm text-ink transition-colors hover:text-copper-700"
          >
            <User className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
            My account
          </Link>
          <Link
            href="/account/orders"
            onClick={onNavigate}
            className="flex min-h-10 items-center gap-2.5 text-sm text-ink transition-colors hover:text-copper-700"
          >
            <Package className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
            My orders
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            className="flex min-h-10 items-center gap-2.5 text-left text-sm text-ink transition-colors hover:text-copper-700"
          >
            <LogOut className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
            Sign out
          </button>
        </div>
      ) : (
        <Link
          href="/account"
          onClick={onNavigate}
          className="flex h-11 items-center justify-center rounded-control bg-ink label-wide text-cream transition-colors hover:bg-ink-700"
        >
          Sign in / Register
        </Link>
      )}
    </div>
  );
}
