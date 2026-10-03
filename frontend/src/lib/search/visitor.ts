/**
 * The storefront's random analytics visitor id, for the search log.
 *
 * The same browser-local id the analytics events use (`dcz:visitor`, see
 * `growthService`), read — and created on first use, in the same format — so
 * a search and a page view from one browser are one visitor. Not tied to a
 * person; the server only ever stores a hash of it.
 */

export const VISITOR_KEY = "dcz:visitor";

/** What the API accepts; anything else it ignores. */
export const VISITOR_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** This browser's visitor id, or `undefined` when storage is unavailable (or on the server). */
export function getVisitorId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    let id = window.localStorage.getItem(VISITOR_KEY);
    if (!id || !VISITOR_PATTERN.test(id)) {
      id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(
        /[^A-Za-z0-9-]/g,
        "",
      );
      window.localStorage.setItem(VISITOR_KEY, id);
    }
    return VISITOR_PATTERN.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
