import type { AdminNotification } from "@/types/admin";

import type { LookupEntity } from "@/lib/lookup/entities";
import { searchAllIds, type IdSearchResults } from "@/services/lookupService";

import { adminDataSource } from "./admin-data-source.instance";

/**
 * Global admin search — by ID (docs/id-lookup.md).
 *
 * One box across every record the role may open, because an administrator
 * arrives with an identifier: an order number from an email, a SKU from a
 * supplier, a transaction reference from a bank statement, a shipment number
 * from a courier. The server matches **identifiers only** — a name, an email
 * or a word finds nothing — and returns IDs grouped by entity, a few each.
 * Choosing one opens that record's preview (`/admin/lookup`).
 *
 * It used to download every order and every customer and match names in the
 * browser; now each keystroke pause is one small request.
 */

export interface AdminSearchResult {
  entity: LookupEntity;
  label: string;
  id: string;
  /** Another identifier that matched (a SKU, a gateway id). */
  match?: string;
}

export interface AdminSearchGroup {
  entity: LookupEntity;
  label: string;
  idLabel: string;
  items: AdminSearchResult[];
  hasMore: boolean;
}

export interface AdminSearchResults {
  groups: AdminSearchGroup[];
  total: number;
}

export const EMPTY_SEARCH_RESULTS: AdminSearchResults = { groups: [], total: 0 };

/** The shortest term worth asking about: one character would match every ID of that letter. */
export const MIN_SEARCH_LENGTH = 2;

function shape(found: IdSearchResults): AdminSearchResults {
  const groups = found.groups.map((group) => ({
    entity: group.entity,
    label: group.label,
    idLabel: group.idLabel,
    hasMore: group.hasMore,
    items: group.items.map((item) => ({ entity: group.entity, label: group.label, id: item.id, match: item.match })),
  }));
  return { groups, total: groups.reduce((sum, group) => sum + group.items.length, 0) };
}

export async function search(
  term: string,
  perGroup = 3,
  { signal }: { signal?: AbortSignal } = {},
): Promise<AdminSearchResults> {
  const trimmed = term.trim();
  if (trimmed.length < MIN_SEARCH_LENGTH) return EMPTY_SEARCH_RESULTS;
  return shape(await searchAllIds(trimmed, { perEntity: perGroup, signal }));
}

/* ------------------------------------------------------------ notifications */

export function listNotifications(): Promise<AdminNotification[]> {
  return adminDataSource.listNotifications();
}

export function markNotificationRead(id: string): Promise<void> {
  return adminDataSource.markNotificationRead(id);
}

export function markAllNotificationsRead(): Promise<void> {
  return adminDataSource.markAllNotificationsRead();
}
