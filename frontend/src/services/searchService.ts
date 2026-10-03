import type { Paginated, Product, ProductQuery, SearchSuggestions } from "@/types";

import { getVisitorId } from "@/lib/search/visitor";
import { apiGet, apiUrl, getToken, query } from "@/services/api/client";

import { dataSource } from "./data-source.instance";

/**
 * Search is a catalogue query with a `q` term, so it reuses the same pipeline
 * as every listing page — which is why search results support the identical
 * filters and sorting rather than being a separate, weaker screen.
 */
export function searchProducts(
  term: string,
  query: Omit<ProductQuery, "query"> = {},
): Promise<Paginated<Product>> {
  return dataSource.queryProducts({ ...query, query: term });
}

export const EMPTY_SUGGESTIONS: SearchSuggestions = {
  query: "",
  correctedTerm: null,
  products: [],
  categories: [],
  brands: [],
  popular: [],
};

/**
 * Type-ahead suggestions for the header search box: `GET /search/suggest`.
 *
 * A light payload built for the dropdown — a few products, matching
 * categories and brands, a "did you mean" when nothing matched, and the
 * store's popular searches. A blank or one-letter term returns only the
 * popular searches (that is how the empty dropdown gets them).
 *
 * `signal` lets the caller abort a request a newer keystroke has made stale.
 */
export async function getSearchSuggestions(
  term: string,
  { limit = 6, signal }: { limit?: number; signal?: AbortSignal } = {},
): Promise<SearchSuggestions> {
  const data = await apiGet<Partial<SearchSuggestions>>(
    `/search/suggest${query({ q: term.trim().slice(0, 100), limit: Math.min(10, Math.max(1, limit)) })}`,
    { signal },
  );
  return {
    query: data?.query ?? term.trim(),
    correctedTerm: data?.correctedTerm ?? null,
    products: Array.isArray(data?.products) ? data.products : [],
    categories: Array.isArray(data?.categories) ? data.categories : [],
    brands: Array.isArray(data?.brands) ? data.brands : [],
    popular: Array.isArray(data?.popular) ? data.popular.filter((entry) => typeof entry === "string") : [],
  };
}

/**
 * 1-based position of a result over the whole list: page 2's first item is
 * `pageSize + 1` (what `POST /search/click` expects).
 */
export function resultPosition(page: number, pageSize: number, index: number): number {
  return (Math.max(1, page) - 1) * Math.max(1, pageSize) + index + 1;
}

/**
 * Record that a search result was opened: `POST /search/click`.
 *
 * Fire and forget. A `keepalive` fetch survives the navigation the click
 * starts, and nothing here can throw or delay that navigation — a failure,
 * an offline browser or a missing `fetch` is simply ignored. (`sendBeacon`
 * cannot send a JSON body cross-origin, which is why it is not used.)
 */
export function trackSearchClick(click: { searchId: number; productId: string; position: number }): void {
  try {
    if (typeof window === "undefined" || typeof fetch !== "function") return;
    if (!Number.isInteger(click.searchId) || click.searchId < 1 || !click.productId || click.position < 1) return;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getToken("customer");
    if (token) headers.Authorization = `Bearer ${token}`;
    const visitorId = getVisitorId();

    void fetch(apiUrl("/search/click"), {
      method: "POST",
      keepalive: true,
      headers,
      body: JSON.stringify({
        searchId: click.searchId,
        productId: click.productId.slice(0, 20),
        position: Math.min(100_000, Math.floor(click.position)),
        ...(visitorId ? { visitorId } : {}),
      }),
    }).catch(() => undefined);
  } catch {
    /* analytics must never break a click */
  }
}
