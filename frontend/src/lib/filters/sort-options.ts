import type { SortOption } from "@/types/product";

import { VALID_SORTS } from "./search-params";

/**
 * The listing's sort menu: exactly the orders `GET /api/products` accepts.
 *
 * Labels default to the ones below; the store's content document may rename
 * any of them (`sortOptions`), but cannot add an order the API would reject.
 * `relevance` is only offered — and is the default — when there is a search
 * term: without one the API treats it as `recommended`.
 */

export const SORT_LABELS: Record<SortOption, string> = {
  relevance: "Relevance",
  recommended: "Recommended",
  newest: "Newest first",
  oldest: "Oldest first",
  "price-asc": "Price: low to high",
  "price-desc": "Price: high to low",
  "best-selling": "Best selling",
  popular: "Most popular",
  rating: "Customer rating",
  discount: "Biggest discount",
  availability: "In stock first",
};

/** Menu order: the defaults first, then the common choices. */
const ORDER: SortOption[] = [
  "relevance",
  "recommended",
  "newest",
  "oldest",
  "price-asc",
  "price-desc",
  "best-selling",
  "popular",
  "rating",
  "discount",
  "availability",
];

export interface SortChoice {
  value: SortOption;
  label: string;
}

export function sortOptionsFor(
  hasSearchTerm: boolean,
  contentLabels: { value: string; label: string }[] = [],
): SortChoice[] {
  const renamed = new Map(
    contentLabels
      .filter((entry) => entry && typeof entry.label === "string" && entry.label.trim())
      .map((entry) => [entry.value, entry.label.trim()] as const),
  );
  return ORDER.filter((value) => VALID_SORTS.includes(value))
    .filter((value) => hasSearchTerm || value !== "relevance")
    .map((value) => ({ value, label: renamed.get(value) ?? SORT_LABELS[value] }));
}
