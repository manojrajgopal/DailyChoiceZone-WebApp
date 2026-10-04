import { apiGet, query } from "@/services/api/client";
import { LOOKUP_ENTITIES, type LookupEntity, type LookupScope } from "@/lib/lookup/entities";

/**
 * ID lookup (docs/id-lookup.md).
 *
 * Two calls, never mixed:
 *
 * - `suggestIds` — the IDs that start like what was typed. Identifiers only:
 *   cheap enough for every pause in typing, and nothing to leak.
 * - `resolveId` — exactly one ID, as a short preview of the record. Made once,
 *   after a choice.
 *
 * `admin` asks the portal endpoints (each entity checks the role's own
 * permission); `account` asks the customer's, which only ever find the
 * customer's own records.
 */

export interface IdSuggestion {
  id: string;
  /** Present when another identifier matched (a SKU, a gateway id): that value. */
  match?: string;
}

export interface IdSuggestions {
  entity: LookupEntity;
  label: string;
  idLabel: string;
  query: string;
  items: IdSuggestion[];
  hasMore: boolean;
}

export type IdFieldFormat = "text" | "money" | "number" | "date";

export interface IdPreviewField {
  label: string;
  value: string | number;
  format: IdFieldFormat;
}

export interface IdRelated {
  entity: LookupEntity;
  id: string;
  label: string;
}

export interface IdPreview {
  entity: LookupEntity;
  label: string;
  idLabel: string;
  /** The ID people read: `DCZ10241`, `PRD001`. */
  id: string;
  /** What the record's own screen opens with (`?id=`). */
  key: string;
  volatile: boolean;
  title: string;
  subtitle: string;
  status: string;
  image: string | null;
  fields: IdPreviewField[];
  related: IdRelated[];
}

export interface IdGroup extends IdSuggestions {
  entity: LookupEntity;
}

export interface IdSearchResults {
  query: string;
  groups: IdGroup[];
  total: number;
}

/** Most suggestions one request may ask for (the backend's cap). */
export const MAX_SUGGESTIONS = 20;

const BASE: Record<LookupScope, string> = { admin: "/admin/lookup", account: "/account/lookup" };

function auth(scope: LookupScope) {
  return scope === "admin" ? ("admin" as const) : ("customer" as const);
}

/** Upper case, no spaces, no leading `#` — the backend reads IDs the same way. */
export function normaliseId(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase().replace(/^#+/, "");
}

export function suggestIds(
  scope: LookupScope,
  entity: LookupEntity,
  term: string,
  { limit, signal }: { limit?: number; signal?: AbortSignal } = {},
): Promise<IdSuggestions> {
  return apiGet<IdSuggestions>(
    `${BASE[scope]}/${entity}${query({ q: term.trim(), limit: limit ? Math.min(limit, MAX_SUGGESTIONS) : undefined })}`,
    { auth: auth(scope), signal },
  );
}

/* ------------------------------------------------------------ the preview */

/**
 * Previews of slow-moving records (a category, a supplier) are reused for a
 * minute, so picking the same one twice is one request. Anything whose stock,
 * status or money moves (`volatile`) is always fetched fresh.
 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: IdPreview }>();
// Two cards asking for the same ID at once share one request.
const inFlight = new Map<string, Promise<IdPreview>>();

function cacheKey(scope: LookupScope, entity: LookupEntity, id: string): string {
  return `${scope}:${entity}:${normaliseId(id)}`;
}

export function clearIdCache(): void {
  cache.clear();
  inFlight.clear();
}

export async function resolveId(
  scope: LookupScope,
  entity: LookupEntity,
  id: string,
  { signal, fresh = false }: { signal?: AbortSignal; fresh?: boolean } = {},
): Promise<IdPreview> {
  const key = cacheKey(scope, entity, id);
  const cacheable = !LOOKUP_ENTITIES[entity].volatile;

  if (cacheable && !fresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const pending = inFlight.get(key);
    if (pending) return pending;
  }

  const request = apiGet<IdPreview>(`${BASE[scope]}/${entity}/${encodeURIComponent(id.trim())}`, {
    auth: auth(scope),
    signal,
  });
  if (!cacheable) return request;

  inFlight.set(key, request);
  try {
    const value = await request;
    if (!value.volatile) {
      cache.set(key, { at: Date.now(), value });
      // A preview read by its other identifier (ORD001 for DCZ10241) answers both.
      cache.set(cacheKey(scope, entity, value.id), { at: Date.now(), value });
    }
    return value;
  } finally {
    inFlight.delete(key);
  }
}

/* ------------------------------------------------------- every entity */

/** The portal's one box: every ID starting like this, grouped by entity the role may open. */
export function searchAllIds(
  term: string,
  { perEntity = 3, signal }: { perEntity?: number; signal?: AbortSignal } = {},
): Promise<IdSearchResults> {
  return apiGet<IdSearchResults>(`/admin/lookup${query({ q: term.trim(), perEntity })}`, { auth: "admin", signal });
}

export interface LookupEntityInfo {
  entity: LookupEntity;
  label: string;
  idLabel: string;
  example: string;
  volatile: boolean;
}

/** What this administrator (or customer) can look up. */
export async function listLookupEntities(scope: LookupScope, signal?: AbortSignal): Promise<LookupEntityInfo[]> {
  const data = await apiGet<{ items: LookupEntityInfo[] }>(`${BASE[scope]}/entities`, { auth: auth(scope), signal });
  return data.items;
}
