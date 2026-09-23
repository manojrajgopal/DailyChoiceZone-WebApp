import { readJson, remove as removeKey, writeJson } from "@/lib/storage/local-storage";

/**
 * The mock persistence layer.
 *
 * There is no backend, so admin writes are kept as an **overlay** on top of the
 * committed JSON rather than by rewriting it: a set of created records, a map of
 * edits by id, and a set of deleted ids. Reading resolves the three against the
 * base data.
 *
 * Why an overlay instead of copying the whole collection into local storage:
 *
 * - The committed JSON stays the source of truth, so `npm run data:admin` can
 *   regenerate it without wiping an admin's work.
 * - An edit records only what changed, which is what a `PUT` will send later.
 * - Clearing the overlay restores the pristine demo data in one action.
 *
 * This is deliberately temporary. Every function here maps onto one HTTP verb,
 * so `mock-admin-adapter` can be swapped for `http-admin-adapter` without any
 * caller noticing.
 */

const PREFIX = "dcz:admin:";

export const OVERLAY_KEYS = {
  products: `${PREFIX}products`,
  categories: `${PREFIX}categories`,
  collections: `${PREFIX}collections`,
  orders: `${PREFIX}orders`,
  customers: `${PREFIX}customers`,
  coupons: `${PREFIX}coupons`,
  reviews: `${PREFIX}reviews`,
  banners: `${PREFIX}banners`,
  homepage: `${PREFIX}homepage`,
  adminUsers: `${PREFIX}admin-users`,
  settings: `${PREFIX}settings`,
  stockLog: `${PREFIX}stock-log`,
  session: `${PREFIX}session`,
  notifications: `${PREFIX}notifications`,
} as const;

/**
 * The keys that hold a whole document rather than an overlay.
 *
 * Settings and the homepage layout are single records, so there is nothing to
 * create or delete — they are stored entire. Everything that walks the key
 * list has to know the difference.
 */
const DOCUMENT_KEYS: string[] = [OVERLAY_KEYS.settings, OVERLAY_KEYS.homepage];

export interface Overlay<T> {
  /** Records added since the base data was generated. */
  created: T[];
  /** Full replacements, by id. A `PUT` body. */
  updated: Record<string, T>;
  deletedIds: string[];
}

const EMPTY: Overlay<never> = { created: [], updated: {}, deletedIds: [] };

function isOverlay(value: unknown): value is Overlay<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Overlay<unknown>>;
  return (
    Array.isArray(candidate.created) &&
    Array.isArray(candidate.deletedIds) &&
    typeof candidate.updated === "object" &&
    candidate.updated !== null
  );
}

function readOverlay<T>(key: string): Overlay<T> {
  const stored = readJson<unknown>(key, EMPTY);
  // Local storage is not ours alone: a value can survive a schema change, or
  // be written under the wrong key. Anything that is not overlay-shaped is
  // treated as no overlay at all rather than crashing the page that reads it.
  return isOverlay(stored) ? (stored as Overlay<T>) : (EMPTY as unknown as Overlay<T>);
}

/**
 * Apply an overlay to base records.
 *
 * Order matters: edits first, then deletions, then additions. Created records
 * go last so the newest appear at the end of the natural order, and a created
 * record that is later deleted disappears correctly.
 */
export function resolve<T extends { id: string }>(base: T[], key: string): T[] {
  const overlay = readOverlay<T>(key);

  const hasEdits =
    overlay.created.length > 0 ||
    overlay.deletedIds.length > 0 ||
    Object.keys(overlay.updated).length > 0;

  if (!hasEdits) return base;

  const deleted = new Set(overlay.deletedIds);

  const merged = base
    .map((record) => overlay.updated[record.id] ?? record)
    .filter((record) => !deleted.has(record.id));

  const created = overlay.created
    .map((record) => overlay.updated[record.id] ?? record)
    .filter((record) => !deleted.has(record.id));

  return [...merged, ...created];
}

/* --------------------------------------------------------------------- writes */

/** Add a record. Mirrors `POST /admin/<collection>`. */
export function create<T extends { id: string }>(key: string, record: T): T {
  const overlay = readOverlay<T>(key);
  writeJson(key, { ...overlay, created: [...overlay.created, record] });
  return record;
}

/** Replace a record. Mirrors `PUT /admin/<collection>/:id`. */
export function update<T extends { id: string }>(key: string, record: T): T {
  const overlay = readOverlay<T>(key);
  writeJson(key, { ...overlay, updated: { ...overlay.updated, [record.id]: record } });
  return record;
}

/** Remove a record. Mirrors `DELETE /admin/<collection>/:id`. */
export function remove(key: string, id: string): void {
  const overlay = readOverlay<unknown>(key);
  if (overlay.deletedIds.includes(id)) return;
  writeJson(key, { ...overlay, deletedIds: [...overlay.deletedIds, id] });
}

/**
 * Discard every local change and return to the committed demo data.
 *
 * Exposed in store settings, because a demo that cannot be reset accumulates
 * junk until it stops demonstrating anything.
 */
export function resetAll(): void {
  Object.values(OVERLAY_KEYS).forEach((key) => {
    if (key === OVERLAY_KEYS.session) return; // never sign the admin out
    // Removing the key, rather than writing an empty overlay into it, is what
    // restores the committed data: a document key given an empty *overlay*
    // would read back as that overlay instead of falling through to the base.
    removeKey(key);
  });
}

/** How many local changes exist, for the "unsaved demo data" indicator. */
export function countLocalChanges(): number {
  return Object.values(OVERLAY_KEYS).reduce((total, key) => {
    if (key === OVERLAY_KEYS.session) return total;

    // A document key is one change or none — it has no created/deleted parts.
    if (DOCUMENT_KEYS.includes(key)) {
      return total + (readJson<unknown>(key, null) === null ? 0 : 1);
    }

    const overlay = readOverlay<unknown>(key);
    return (
      total +
      overlay.created.length +
      overlay.deletedIds.length +
      Object.keys(overlay.updated).length
    );
  }, 0);
}

/* ------------------------------------------------- single-document overlays */

/**
 * Settings and the homepage are one document, not a collection, so they are
 * stored whole rather than as an overlay.
 */
export function readDocument<T>(key: string, base: T): T {
  return readJson<T>(key, base);
}

export function writeDocument<T>(key: string, value: T): T {
  writeJson(key, value);
  return value;
}
