import { STORAGE_KEYS } from "@/lib/storage/local-storage";

/**
 * Recent searches, kept in this browser only (never sent to the server).
 *
 * The last eight distinct terms, newest first. Every access is guarded:
 * private browsing, blocked site data or a corrupt value all degrade to "no
 * recent searches" rather than an error.
 */

export const RECENT_SEARCHES_KEY = STORAGE_KEYS.recentSearches;
export const MAX_RECENT_SEARCHES = 8;
const MAX_TERM_LENGTH = 100;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function clean(term: string): string {
  return term.trim().replace(/\s+/g, " ").slice(0, MAX_TERM_LENGTH);
}

export function readRecentSearches(): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const parsed: unknown = JSON.parse(store.getItem(RECENT_SEARCHES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map(clean)
      .filter(Boolean)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

function write(terms: string[]): void {
  const store = storage();
  if (!store) return;
  try {
    if (terms.length) store.setItem(RECENT_SEARCHES_KEY, JSON.stringify(terms));
    else store.removeItem(RECENT_SEARCHES_KEY);
  } catch {
    /* full or blocked: recent searches are a convenience */
  }
}

/** Put `term` first (moving it if it is already there) and keep the last eight. Returns the new list. */
export function addRecentSearch(term: string): string[] {
  const value = clean(term);
  const current = readRecentSearches();
  if (!value) return current;
  const next = [value, ...current.filter((entry) => entry.toLowerCase() !== value.toLowerCase())].slice(
    0,
    MAX_RECENT_SEARCHES,
  );
  write(next);
  return next;
}

export function removeRecentSearch(term: string): string[] {
  const next = readRecentSearches().filter((entry) => entry.toLowerCase() !== clean(term).toLowerCase());
  write(next);
  return next;
}

export function clearRecentSearches(): void {
  write([]);
}
