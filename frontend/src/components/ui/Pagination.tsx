"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Page numbers with ellipses.
 *
 * Always returns a fixed-length window so the control does not change width
 * as you page through, which would make the buttons move under the cursor.
 */
export function buildPageWindow(current: number, total: number): (number | "gap")[] {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  if (current <= 4) return [1, 2, 3, 4, 5, "gap", total];
  if (current >= total - 3) return [1, "gap", total - 4, total - 3, total - 2, total - 1, total];

  return [1, "gap", current - 1, current, current + 1, "gap", total];
}

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}

export function Pagination({ page, totalPages, onPageChange, className }: PaginationProps) {
  if (totalPages <= 1) return null;

  const window = buildPageWindow(page, totalPages);

  const arrow =
    "inline-flex h-9 w-9 items-center justify-center rounded-control border border-ink-200 " +
    "text-ink transition-colors hover:border-ink hover:bg-ink hover:text-cream " +
    "disabled:cursor-not-allowed disabled:border-ink-100 disabled:text-ink-300 " +
    "disabled:hover:bg-transparent disabled:hover:text-ink-300";

  return (
    <nav aria-label="Pagination" className={cn("flex items-center justify-center gap-1.5", className)}>
      <button
        type="button"
        className={arrow}
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
      </button>

      {window.map((entry, index) =>
        entry === "gap" ? (
          <span
            key={`gap-${index}`}
            className="px-1 text-sm text-ink-300"
            aria-hidden="true"
          >
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
              "inline-flex h-9 min-w-9 items-center justify-center rounded-control border px-2.5 text-sm tabular-nums transition-colors",
              entry === page
                ? "border-ink bg-ink text-cream"
                : "border-ink-200 text-ink hover:border-ink",
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
        <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </nav>
  );
}
