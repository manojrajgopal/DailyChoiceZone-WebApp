"use client";

import Link from "next/link";

import { usePopularSearches } from "@/hooks/useSearch";
import { useSiteContent } from "@/hooks/useSiteContent";
import { cn } from "@/lib/utils/cn";

/**
 * The store's popular searches as links to `/search?q=`.
 *
 * From the search analytics (`GET /search/suggest`), falling back to the
 * content document's list while that loads or when it is empty.
 */
export function PopularSearches({
  title = "Popular searches",
  className,
  align = "center",
}: {
  title?: string;
  className?: string;
  align?: "center" | "start";
}) {
  const fallback = useSiteContent()?.popularSearches ?? [];
  const popular = usePopularSearches(fallback);
  if (popular.length === 0) return null;

  return (
    <div className={cn("mx-auto max-w-lg", className)}>
      <p className={cn("label-wide mb-3 text-ink-500", align === "center" && "text-center")}>{title}</p>
      <ul className={cn("flex flex-wrap gap-2", align === "center" && "justify-center")}>
        {popular.map((term) => (
          <li key={term}>
            <Link
              href={`/search?q=${encodeURIComponent(term)}`}
              className="inline-flex rounded-pill border border-ink-200 px-3.5 py-1.5 text-sm text-ink-700 transition-colors hover:border-ink hover:text-ink"
            >
              {term}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
