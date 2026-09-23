"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { buildPageWindow } from "@/components/ui/Pagination";
import { cn } from "@/lib/utils/cn";

/**
 * Compact pagination for admin tables.
 *
 * Reuses the storefront's `buildPageWindow` so both paginators produce the
 * identical page window — the arithmetic is the same problem, and having two
 * copies would mean fixing an off-by-one twice.
 */
export function AdminPagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  const window = buildPageWindow(page, totalPages);

  const arrow =
    "inline-flex h-7 w-7 items-center justify-center rounded-[3px] border border-admin-border " +
    "text-admin-ink transition-colors hover:border-admin-border-strong hover:bg-admin-raised " +
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  return (
    <nav aria-label="Pagination" className="flex items-center gap-1">
      <button
        type="button"
        className={arrow}
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
      </button>

      {window.map((entry, index) =>
        entry === "gap" ? (
          <span key={`gap-${index}`} className="px-1 text-xs text-admin-faint" aria-hidden="true">
            &hellip;
          </span>
        ) : (
          <button
            key={entry}
            type="button"
            onClick={() => onPageChange(entry)}
            aria-label={`Page ${entry}`}
            aria-current={entry === page ? "page" : undefined}
            className={cn(
              "inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] border px-2 text-xs tabular-nums transition-colors",
              entry === page
                ? "border-copper-600 bg-copper-600 text-white"
                : "border-admin-border text-admin-ink hover:bg-admin-raised",
            )}
          >
            {entry}
          </button>
        ),
      )}

      <button
        type="button"
        className={arrow}
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        aria-label="Next page"
      >
        <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </nav>
  );
}
