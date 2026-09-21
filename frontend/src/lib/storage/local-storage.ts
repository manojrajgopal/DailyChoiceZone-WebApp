/**
 * A guarded wrapper around `localStorage`.
 *
 * Every access is wrapped because `localStorage` is not merely absent during
 * server rendering — it also throws in private browsing modes and when a user
 * has blocked site data. A storefront must never white-screen because someone
 * tightened their browser settings, so every failure degrades to "no value".
 *
 * All keys are namespaced, so clearing Daily Choice Zone data never touches
 * anything else served from the same origin.
 */

const NAMESPACE = "dcz";

export const STORAGE_KEYS = {
  cart: `${NAMESPACE}:cart`,
  wishlist: `${NAMESPACE}:wishlist`,
  recentlyViewed: `${NAMESPACE}:recently-viewed`,
  session: `${NAMESPACE}:session`,
  orders: `${NAMESPACE}:orders`,
  addresses: `${NAMESPACE}:addresses`,
  checkout: `${NAMESPACE}:checkout`,
} as const;

function available(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage != null;
  } catch {
    return false;
  }
}

/** Read and parse a JSON value, returning `fallback` on any failure. */
export function readJson<T>(key: string, fallback: T): T {
  if (!available()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt or unreadable — treat it as absent rather than crashing.
    return fallback;
  }
}

/** Serialise and persist a value. Returns whether it was actually stored. */
export function writeJson(key: string, value: unknown): boolean {
  if (!available()) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Most likely a full quota or a blocked store.
    return false;
  }
}

export function remove(key: string): void {
  if (!available()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing useful to do here.
  }
}

/** Clear every namespaced key. Used by sign-out. */
export function clearAll(): void {
  if (!available()) return;
  try {
    Object.values(STORAGE_KEYS).forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Nothing useful to do here.
  }
}
