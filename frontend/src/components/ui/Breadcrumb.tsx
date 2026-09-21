import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  /** Omit on the final crumb — the current page is not a link. */
  href?: string;
}

/**
 * Breadcrumbs.
 *
 * An ordered list inside a labelled nav, which is what lets assistive tech
 * announce it as a breadcrumb trail. The current page is marked with
 * `aria-current` rather than merely being unlinked.
 */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-500">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
              {item.href && !isLast ? (
                <Link href={item.href} className="transition-colors hover:text-ink">
                  {item.label}
                </Link>
              ) : (
                <span className="text-ink" aria-current={isLast ? "page" : undefined}>
                  {item.label}
                </span>
              )}

              {!isLast ? (
                <ChevronRight className="h-3 w-3 text-ink-300" strokeWidth={1.5} aria-hidden="true" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
