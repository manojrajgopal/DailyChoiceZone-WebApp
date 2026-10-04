import type { Product } from "@/types";

import { apiDelete, apiGet, apiPost, apiPut, query } from "@/services/api/client";
import type { RecommendationType, SizeGuide, SizeGuideColumn } from "@/services/discoveryService";

/**
 * Portal calls for product discovery: the relationships the store chooses
 * between products, size guides, a product's own delivery rules, the
 * delivery-estimate settings and the recently-viewed figures. Every
 * permission is checked by the server (`products`, `shipping`, `analytics`,
 * `customers`); the portal only shows what it was allowed to read.
 */

const ADMIN = { auth: "admin" } as const;

/* ------------------------------------------------------------ relationships */

export const RELATIONSHIP_TYPES: { value: RecommendationType; label: string; hint: string }[] = [
  { value: "related", label: "Related", hint: "“You may also like” — the broad rail" },
  { value: "frequently-bought-together", label: "Frequently bought together", hint: "Things bought in the same order" },
  { value: "similar", label: "Similar", hint: "Alike in kind and price" },
  { value: "alternative", label: "Alternative", hint: "Something to choose instead" },
  { value: "accessory", label: "Accessory", hint: "Goes with it; also shown under Related" },
];

export interface Relationship {
  id: number;
  productId: string;
  relatedProductId: string;
  type: RecommendationType;
  position: number;
  active: boolean;
  createdBy: string;
  createdAt: string;
  related: { id: string; name: string; sku: string; status: string; price: number; stock: number; image: string }
    | null;
}

export function listRelationships(productId: string): Promise<Relationship[]> {
  return apiGet(`/admin/products/${encodeURIComponent(productId)}/relationships`, ADMIN);
}

export function addRelationships(
  productId: string,
  input: { relatedProductIds: string[]; type: RecommendationType; reciprocal?: boolean; active?: boolean },
): Promise<Relationship[]> {
  return apiPost(`/admin/products/${encodeURIComponent(productId)}/relationships`, input, ADMIN);
}

export function updateRelationship(
  productId: string,
  id: number,
  input: { active?: boolean; type?: RecommendationType },
): Promise<Relationship[]> {
  return apiPut(`/admin/products/${encodeURIComponent(productId)}/relationships/${id}`, input, ADMIN);
}

export function deleteRelationship(productId: string, id: number): Promise<Relationship[]> {
  return apiDelete(`/admin/products/${encodeURIComponent(productId)}/relationships/${id}`, ADMIN);
}

export function reorderRelationships(productId: string, type: RecommendationType, ids: number[]): Promise<Relationship[]> {
  return apiPut(`/admin/products/${encodeURIComponent(productId)}/relationships/order`, { type, ids }, ADMIN);
}

export interface PreviewEntry {
  source: "manual" | "score" | "copurchase" | "fallback-category" | "fallback-best-sellers";
  score: number | null;
  inStock: boolean;
  product: Product;
}

export function previewRecommendations(productId: string, type: RecommendationType, limit = 8): Promise<{
  type: RecommendationType;
  items: PreviewEntry[];
}> {
  return apiGet(`/admin/products/${encodeURIComponent(productId)}/recommendations${query({ type, limit })}`, ADMIN);
}

/* -------------------------------------------------------------- size guides */

export interface AdminSizeGuide {
  id: string;
  name: string;
  kind: SizeGuide["kind"];
  description: string;
  unit: "cm" | "in" | "mm";
  columns: SizeGuideColumn[];
  rows: { size: string; values: Record<string, { min: number; max?: number } | string> }[];
  instructions: { title: string; body: string; column: string }[];
  notes: string;
  status: "active" | "inactive";
  isDefault: boolean;
  categoryIds: string[];
  products: number;
  categories: number;
  updatedAt: string;
  assignedProducts?: { id: string; name: string; status: string }[];
}

export interface SizeGuideList {
  items: AdminSizeGuide[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  templates: Record<string, SizeGuideColumn[]>;
}

/** What the editor sends: cells may be typed as "92-96" and are parsed by the server. */
export interface SizeGuideInput {
  name: string;
  kind: SizeGuide["kind"];
  description: string;
  unit: "cm" | "in" | "mm";
  columns: SizeGuideColumn[];
  rows: { size: string; values: Record<string, string> }[];
  instructions: { title: string; body: string; column: string }[];
  notes: string;
  status: "active" | "inactive";
  isDefault: boolean;
}

export function listSizeGuides(filters: { q?: string; status?: string; kind?: string; page?: number } = {}):
  Promise<SizeGuideList> {
  return apiGet(`/admin/size-guides${query(filters)}`, ADMIN);
}

export function getSizeGuide(id: string): Promise<AdminSizeGuide> {
  return apiGet(`/admin/size-guides/${encodeURIComponent(id)}`, ADMIN);
}

export function createSizeGuide(input: SizeGuideInput): Promise<AdminSizeGuide> {
  return apiPost("/admin/size-guides", input, ADMIN);
}

export function updateSizeGuide(id: string, input: Partial<SizeGuideInput>): Promise<AdminSizeGuide> {
  return apiPut(`/admin/size-guides/${encodeURIComponent(id)}`, input, ADMIN);
}

export function deleteSizeGuide(id: string): Promise<{ products: number; categories: number }> {
  return apiDelete(`/admin/size-guides/${encodeURIComponent(id)}`, ADMIN);
}

export function setSizeGuideCategories(id: string, categoryIds: string[]):
  Promise<{ categories: string[]; movedFromOtherGuides: number }> {
  return apiPut(`/admin/size-guides/${encodeURIComponent(id)}/categories`, { categoryIds }, ADMIN);
}

export function setSizeGuideProducts(id: string, productIds: string[], mode: "add" | "remove" | "replace" = "add"):
  Promise<{ added: number; removed: number; products: number }> {
  return apiPut(`/admin/size-guides/${encodeURIComponent(id)}/products`, { productIds, mode }, ADMIN);
}

export interface ProductSizeGuideState {
  assignedGuideId: string | null;
  source: "product" | "category" | "default" | "none";
  guide: SizeGuide | null;
}

export function getProductSizeGuide(productId: string): Promise<ProductSizeGuideState> {
  return apiGet(`/admin/products/${encodeURIComponent(productId)}/size-guide`, ADMIN);
}

export function setProductSizeGuide(productId: string, sizeGuideId: string | null): Promise<ProductSizeGuideState> {
  return apiPut(`/admin/products/${encodeURIComponent(productId)}/size-guide`, { sizeGuideId }, ADMIN);
}

/* ------------------------------------------------------------ delivery rules */

export interface DeliveryExclusion {
  id?: number;
  kind: "pincode" | "prefix" | "state";
  value: string;
  reason: string;
}

export interface ProductDeliveryRules {
  productId: string;
  codAllowed: boolean;
  expressAllowed: boolean;
  dispatchDays: number | null;
  note: string;
  exclusions: DeliveryExclusion[];
  configured: boolean;
}

export function getProductDeliveryRules(productId: string): Promise<ProductDeliveryRules> {
  return apiGet(`/admin/products/${encodeURIComponent(productId)}/delivery`, ADMIN);
}

export function saveProductDeliveryRules(
  productId: string,
  rules: Omit<ProductDeliveryRules, "productId" | "configured">,
): Promise<ProductDeliveryRules> {
  return apiPut(`/admin/products/${encodeURIComponent(productId)}/delivery`, rules, ADMIN);
}

export interface DeliveryEstimateSettings {
  restrictToListed: boolean;
  dispatchCutoffHour: number | null;
  processingDays: number;
  standardMinDays: number;
  standardMaxDays: number;
  expressMinDays: number;
  expressMaxDays: number;
  workingDays: number[];
  holidays: string[];
  utcOffsetMinutes: number;
  codMaxOrderValue: number | null;
}

export function getDeliverySettings(): Promise<DeliveryEstimateSettings> {
  return apiGet("/admin/delivery/settings", ADMIN);
}

export function saveDeliveryEstimateSettings(settings: Partial<DeliveryEstimateSettings>):
  Promise<DeliveryEstimateSettings> {
  return apiPut("/admin/delivery/settings", settings, ADMIN);
}

/* ------------------------------------------------------------------ insight */

export interface DiscoverySummary {
  customers: number;
  entries: number;
  limit: number;
  retentionDays: number;
  topProducts: { productId: string; name: string; customers: number; views: number }[];
}

export function getDiscoverySummary(days = 30): Promise<DiscoverySummary> {
  return apiGet(`/admin/discovery/summary${query({ days })}`, ADMIN);
}

export interface CustomerDiscovery {
  recentlyViewed: { productId: string; name: string; status: string; viewedAt: string; viewCount: number }[];
  savedForLater: { id: number; productId: string; name: string; status: string; size: string | null;
    color: string | null; quantity: number; savedAt: string }[];
}

export function getCustomerDiscovery(customerId: string): Promise<CustomerDiscovery> {
  return apiGet(`/admin/customers/${encodeURIComponent(customerId)}/discovery`, ADMIN);
}
