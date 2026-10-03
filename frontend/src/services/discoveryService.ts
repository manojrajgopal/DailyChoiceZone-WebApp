import type { Product } from "@/types";

import { apiDelete, apiGet, apiGetPage, apiPost, apiPut, query, type Page } from "@/services/api/client";
import type { ServerCart } from "@/services/cartService";

/**
 * Product discovery: recently viewed, saved for later, availability by
 * location, size guides and recommendations. See docs/product-discovery.md.
 *
 * Everything here is the server's answer. Signed-out shoppers keep their
 * recently viewed and saved-for-later lists in the browser (the stores) and
 * hand them over once at sign-in through the `merge*` calls below — the same
 * arrangement as the guest bag.
 */

const AUTH = { auth: "customer" } as const;

/* ------------------------------------------------------------ recently viewed */

export interface RecentlyViewedEntry {
  productId: string;
  color: string | null;
  size: string | null;
  viewedAt: string;
  viewCount: number;
  /** In stock and on sale right now. */
  available: boolean;
  availability: "in-stock" | "out-of-stock";
  product: Product;
}

export function fetchRecentlyViewed(
  options: { page?: number; pageSize?: number; exclude?: string } = {},
): Promise<Page<RecentlyViewedEntry>> {
  return apiGetPage<RecentlyViewedEntry>(
    `/recently-viewed${query({ page: options.page, pageSize: options.pageSize, exclude: options.exclude })}`,
    AUTH,
  );
}

export function recordProductView(input: {
  productId: string;
  color?: string | null;
  size?: string | null;
  source?: string;
}): Promise<{ recorded: boolean }> {
  return apiPost("/recently-viewed", input, AUTH);
}

export function removeRecentlyViewed(productId: string): Promise<void> {
  return apiDelete(`/recently-viewed/${encodeURIComponent(productId)}`, AUTH);
}

export function clearRecentlyViewed(): Promise<{ removed: number }> {
  return apiDelete("/recently-viewed", AUTH);
}

export function mergeRecentlyViewed(
  items: { productId: string; viewedAt: number }[],
): Promise<{ merged: number; skipped: number }> {
  return apiPost("/recently-viewed/merge", { items }, AUTH);
}

/* ------------------------------------------------------------ saved for later */

export type SavedStatus = "available" | "limited" | "out-of-stock" | "variant-unavailable" | "unavailable";

export interface SavedItem {
  id: number;
  productId: string;
  size: string | null;
  color: string | null;
  quantity: number;
  savedAt: string;
  /** Today's price, in paise. */
  unitPrice: number;
  /** What it cost when saved, in paise — for "price dropped" only, never charged. */
  savedUnitPrice: number;
  priceDrop: { from: number; to: number } | null;
  priceRise: boolean;
  status: SavedStatus;
  message: string;
  maxQuantity: number;
  canMoveToCart: boolean;
  inWishlist: boolean;
  product: Product;
}

export interface SavedList {
  items: SavedItem[];
  limit: number;
}

export interface SavedWithCart {
  saved: SavedList;
  cart: ServerCart;
  moved?: number;
}

export function fetchSaved(): Promise<SavedList> {
  return apiGet("/cart/saved", AUTH);
}

export function saveForLater(cartItemId: string | number): Promise<SavedWithCart> {
  return apiPost(`/cart/items/${encodeURIComponent(String(cartItemId))}/save-for-later`, undefined, AUTH);
}

export function moveSavedToCart(savedId: number, quantity?: number): Promise<SavedWithCart> {
  return apiPost(`/cart/saved/${savedId}/move-to-cart`, quantity ? { quantity } : undefined, AUTH);
}

export function updateSavedQuantity(savedId: number, quantity: number): Promise<SavedList> {
  return apiPut(`/cart/saved/${savedId}`, { quantity }, AUTH);
}

export function removeSaved(savedId: number): Promise<SavedList> {
  return apiDelete(`/cart/saved/${savedId}`, AUTH);
}

export function clearSaved(): Promise<SavedList> {
  return apiDelete("/cart/saved", AUTH);
}

export function mergeSaved(
  items: { productId: string; size: string | null; color: string | null; quantity: number }[],
): Promise<SavedList & { merged: number; skipped: number }> {
  return apiPost("/cart/saved/merge", { items }, AUTH);
}

/* ---------------------------------------------------------------- availability */

export interface DeliveryWindow {
  dispatchBy: string;
  from: string;
  to: string;
  /** "9–12 Oct". */
  label: string;
  /** "Mon, 12 Oct". */
  latestLabel: string;
}

export type AvailabilityStatus =
  | "available"
  | "limited"
  | "out-of-stock"
  | "select-variant"
  | "restricted"
  | "not-serviceable"
  | "invalid-pincode";

export interface ProductAvailability {
  productId: string;
  pincode: string;
  valid: boolean;
  available: boolean;
  status: AvailabilityStatus;
  message: string;
  deliverable: boolean;
  inventoryAvailable: boolean;
  /** Stock is held per product, not per size or colour. */
  inventoryScope: "product";
  maxQuantity: number;
  variant: { size: string | null; color: string | null; needsSize: boolean };
  location: { city: string; district: string; state: string; listed: boolean };
  estimatedDelivery: DeliveryWindow | null;
  codAvailable: boolean;
  cod: { available: boolean; fee: number | null; maxOrderValue: number | null; reason: string };
  expressAvailable: boolean;
  express: { available: boolean; estimatedDelivery: DeliveryWindow | null; fee: number | null };
  /** Rupees, for this item alone. */
  deliveryFee: number | null;
  standardDeliveryFee: number | null;
  freeDeliveryThreshold: number | null;
  freeDelivery: boolean;
  dispatch: { cutoffHour: number | null; handlingDays: number };
  note: string;
}

export function checkProductAvailability(
  productId: string,
  options: { pincode: string; size?: string | null; color?: string | null; quantity?: number },
  signal?: AbortSignal,
): Promise<ProductAvailability> {
  return apiGet(
    `/products/${encodeURIComponent(productId)}/availability${query({
      pincode: options.pincode,
      size: options.size ?? undefined,
      color: options.color ?? undefined,
      quantity: options.quantity && options.quantity > 1 ? options.quantity : undefined,
    })}`,
    { signal },
  );
}

export interface CartLineAvailability {
  lineId: number;
  productId: string;
  name: string;
  available: boolean;
  status: AvailabilityStatus | "unavailable";
  message: string;
  codAvailable?: boolean;
  expressAvailable?: boolean;
  estimatedDelivery?: DeliveryWindow | null;
}

export interface CartAvailability {
  pincode: string;
  valid: boolean;
  serviceable: boolean;
  reason: string;
  location: { city: string; district: string; state: string };
  lines: CartLineAvailability[];
  allAvailable: boolean;
  unavailableCount: number;
  codAvailable: boolean;
  expressAvailable: boolean;
  estimatedDeliveryBy: string | null;
}

export function checkCartAvailability(pincode: string): Promise<CartAvailability> {
  return apiGet(`/cart/availability${query({ pincode })}`, AUTH);
}

/* ------------------------------------------------------------------ size guides */

export type SizeUnit = "cm" | "in" | "mm";

export interface MeasurementCell {
  min: number;
  max?: number;
}

export interface SizeGuideColumn {
  key: string;
  label: string;
  type: "measurement" | "text";
  required?: boolean;
}

export interface SizeGuideRow {
  size: string;
  values: Record<string, MeasurementCell | string>;
  /** The measurements as stored, in `storedUnit` — converted again without compounding rounding. */
  stored: Record<string, MeasurementCell>;
  /** Whether the product is sold in this size. */
  offered: boolean;
}

export interface SizeGuide {
  id: string;
  name: string;
  kind: "clothing" | "footwear" | "ring" | "general";
  description: string;
  unit: SizeUnit;
  storedUnit: SizeUnit;
  units: SizeUnit[];
  columns: SizeGuideColumn[];
  rows: SizeGuideRow[];
  instructions: { title: string; body: string; column: string }[];
  notes: string;
  source?: "product" | "category" | "default";
  sizeMatch?: {
    productSizes: string[];
    guideSizes: string[];
    missingFromGuide: string[];
    notOffered: string[];
    consistent: boolean;
  };
}

export function getSizeGuide(productId: string): Promise<SizeGuide | null> {
  return apiGet(`/products/${encodeURIComponent(productId)}/size-guide`);
}

/* ------------------------------------------------------------- recommendations */

export type RecommendationType = "related" | "similar" | "frequently-bought-together" | "alternative" | "accessory";

export function getRecommendations(productId: string, type: RecommendationType, limit = 8): Promise<Product[]> {
  return apiGet(`/products/${encodeURIComponent(productId)}/related${query({ type, limit })}`);
}

/** "Recommended for you": the account's history when signed in, or the guest's recently viewed ids. */
export function getForYou(options: { seed?: string[]; limit?: number; signedIn?: boolean } = {}): Promise<Product[]> {
  return apiGet(
    `/recommendations/for-you${query({ limit: options.limit, seed: options.signedIn ? undefined : options.seed })}`,
    options.signedIn ? AUTH : undefined,
  );
}
