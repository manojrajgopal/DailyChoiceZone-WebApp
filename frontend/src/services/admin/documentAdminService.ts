import type { NavItem, SiteConfig, SiteContent } from "@/types";
import type { AdminNavGroup, AdminResult } from "@/types/admin";

import { ApiError, apiGet, apiPut } from "@/services/api/client";
import { refreshSiteContent } from "@/services/siteService";

/**
 * The configuration documents, read and written whole.
 *
 * Each is one row of `setting_documents` and one screen in the portal. They
 * are saved entire rather than field by field because that is what they are —
 * saving half a menu would leave the storefront with half a menu.
 *
 *   GET  /api/admin/settings/{key}
 *   PUT  /api/admin/settings/{key}
 *
 * The server keeps an allowlist of keys, so a crafted one cannot read or write
 * something that was never meant to be configuration.
 */

const AUTH = { auth: "admin" } as const;

export type DocumentKey = "site" | "content" | "navigation" | "admin_navigation";

function read<T>(key: DocumentKey): Promise<T> {
  return apiGet<T>(`/admin/settings/${key}`, AUTH);
}

async function write<T>(key: DocumentKey, value: T): Promise<AdminResult<T>> {
  try {
    const saved = await apiPut<T>(`/admin/settings/${key}`, value, AUTH);
    // The storefront caches the content document for the life of a page load.
    // Dropping the cache means the next read is the version just saved.
    refreshSiteContent();
    return { ok: true, data: saved };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ApiError && error.message
          ? error.message
          : "Those settings could not be saved.",
    };
  }
}

/* ------------------------------------------------------------------- site */

/** Brand, support details, social links, trust points and the footer. */
export function getSiteDocument(): Promise<SiteConfig> {
  return read<SiteConfig>("site");
}

export function saveSiteDocument(value: SiteConfig): Promise<AdminResult<SiteConfig>> {
  return write("site", value);
}

/* ---------------------------------------------------------------- content */

/** Every list the storefront and the portal render. */
export function getContentDocument(): Promise<SiteContent> {
  return read<SiteContent>("content");
}

export function saveContentDocument(value: SiteContent): Promise<AdminResult<SiteContent>> {
  return write("content", value);
}

/* ------------------------------------------------------------- navigation */

/**
 * Stored as `{ items }` and `{ groups }` rather than bare arrays.
 *
 * A JSON document has to be an object for the column to hold it, and naming
 * the field leaves room to add a setting beside the list later without
 * changing the shape everything already reads.
 */
export async function getStorefrontMenu(): Promise<NavItem[]> {
  return (await read<{ items?: NavItem[] }>("navigation")).items ?? [];
}

export function saveStorefrontMenu(items: NavItem[]): Promise<AdminResult<{ items: NavItem[] }>> {
  return write("navigation", { items });
}

export async function getPortalMenu(): Promise<AdminNavGroup[]> {
  return (await read<{ groups?: AdminNavGroup[] }>("admin_navigation")).groups ?? [];
}

export function savePortalMenu(
  groups: AdminNavGroup[],
): Promise<AdminResult<{ groups: AdminNavGroup[] }>> {
  return write("admin_navigation", { groups });
}
