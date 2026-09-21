"use client";

import Link from "next/link";
import Image from "next/image";

import type { NavItem } from "@/types";

/**
 * The desktop mega menu panel.
 *
 * Entirely data-driven — it renders whatever columns `navigation.json`
 * describes, so adding a department is a data edit rather than a JSX edit.
 *
 * Opening and closing is owned by the parent `Header`, which holds the state
 * for hover, focus and Escape. This component only draws the panel.
 */
export function MegaMenu({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  if (!item.columns || item.columns.length === 0) return null;

  return (
    <div className="border-t border-ink-200 bg-cream shadow-raised">
      <div className="page-shell grid gap-8 py-8 lg:grid-cols-[1fr_auto] lg:gap-12">
        <div
          className="grid gap-x-10 gap-y-8"
          style={{
            // Columns follow the data rather than a hardcoded count.
            gridTemplateColumns: `repeat(${Math.min(item.columns.length, 4)}, minmax(0, 1fr))`,
          }}
        >
          {item.columns.map((column) => (
            <div key={column.heading}>
              <p className="label-wide mb-3.5 text-copper-700">{column.heading}</p>
              <ul className="flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={`${column.heading}-${link.href}-${link.label}`}>
                    <Link
                      href={link.href}
                      onClick={onNavigate}
                      className="text-sm text-ink-700 transition-colors hover:text-ink"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {item.promo ? (
          <Link
            href={item.promo.href}
            onClick={onNavigate}
            className="group relative hidden w-72 shrink-0 overflow-hidden rounded-card lg:block"
          >
            <Image
              src={item.promo.image}
              alt=""
              width={288}
              height={216}
              sizes="288px"
              className="h-[13.5rem] w-full object-cover transition-transform duration-500 ease-brand group-hover:scale-105"
            />
            <span className="absolute inset-0 bg-gradient-to-t from-ink/75 via-ink/15 to-transparent" />
            <span className="absolute inset-x-0 bottom-0 p-4">
              <span className="block font-display text-base text-cream">{item.promo.title}</span>
              <span className="mt-0.5 block text-xs text-cream/80">{item.promo.subtitle}</span>
            </span>
          </Link>
        ) : null}
      </div>
    </div>
  );
}
