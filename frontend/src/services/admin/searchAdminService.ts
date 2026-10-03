import { apiDelete, apiGet, apiPost, apiPut, query } from "@/services/api/client";
import type {
  AttributeInput,
  AttributeStatus,
  AttributeValue,
  ProductAttribute,
  ProductAttributeValues,
  SearchAnalytics,
  SearchRange,
  SearchRebuildResult,
  SearchSettings,
  SearchSettingsInput,
} from "@/types/searchAdmin";

/**
 * Portal calls for search & filters: attribute definitions and product values
 * (permission `products`), search analytics, settings and the index rebuild
 * (permission `search`). See docs/search-and-filters.md §6. The paged product
 * list lives in `productAdminService.listProductsPage`.
 */

const ADMIN = { auth: "admin" } as const;
const enc = encodeURIComponent;

/* --------------------------------------------------------------- attributes */

export function listAttributes(status: AttributeStatus | "all" = "all"): Promise<ProductAttribute[]> {
  return apiGet(`/admin/attributes${query({ status })}`, ADMIN);
}

export function getAttribute(id: number): Promise<ProductAttribute> {
  return apiGet(`/admin/attributes/${id}`, ADMIN);
}

export function createAttribute(input: AttributeInput): Promise<ProductAttribute> {
  return apiPost("/admin/attributes", input, ADMIN);
}

/** A partial update; `options`, when sent, replaces the whole list. */
export function updateAttribute(id: number, input: AttributeInput): Promise<ProductAttribute> {
  return apiPut(`/admin/attributes/${id}`, input, ADMIN);
}

export async function deleteAttribute(id: number): Promise<void> {
  await apiDelete(`/admin/attributes/${id}`, ADMIN);
}

/* --------------------------------------------------------- product values */

export function getProductAttributes(productId: string): Promise<ProductAttributeValues> {
  return apiGet(`/admin/products/${enc(productId)}/attributes`, ADMIN);
}

/** Only the codes sent change; `null`, `""` or `[]` clears one. */
export function setProductAttributes(
  productId: string,
  values: Record<string, AttributeValue>,
): Promise<ProductAttributeValues> {
  return apiPut(`/admin/products/${enc(productId)}/attributes`, { values }, ADMIN);
}

/* ------------------------------------------------------- analytics/settings */

export function getSearchAnalytics(range: SearchRange = "30d"): Promise<SearchAnalytics> {
  return apiGet(`/admin/search/analytics${query({ range })}`, ADMIN);
}

export function getSearchSettings(): Promise<SearchSettings> {
  return apiGet("/admin/search/settings", ADMIN);
}

export function saveSearchSettings(input: SearchSettingsInput): Promise<SearchSettings> {
  return apiPut("/admin/search/settings", input, ADMIN);
}

export function rebuildSearchIndex(): Promise<SearchRebuildResult> {
  return apiPost("/admin/search/rebuild", undefined, ADMIN);
}
