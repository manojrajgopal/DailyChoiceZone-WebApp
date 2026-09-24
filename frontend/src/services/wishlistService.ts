import type { Product } from "@/types";

import { apiDelete, apiGet, apiPost } from "@/services/api/client";

import { dataSource } from "./data-source.instance";

/**
 * The wishlist.
 *
 * Stored against the account on the server, so it follows somebody between
 * their phone and their laptop — which is the entire point of saving something
 * for later.
 *
 * Ids are stored, never product copies: a wishlist is often opened weeks after
 * things were added, and that is exactly when a cached price would be wrong.
 *
 * A signed-out visitor keeps theirs locally. It is staging, not truth, and
 * `mergeGuestWishlist` pushes it up on sign-in — the same arrangement the cart
 * uses, and for the same reason.
 */

const AUTH = { auth: "customer" } as const;

export function fetchWishlist(): Promise<Product[]> {
  return apiGet<Product[]>("/wishlist", AUTH);
}

export function fetchWishlistIds(): Promise<string[]> {
  return apiGet<string[]>("/wishlist/ids", AUTH);
}

export function addToWishlist(productId: string): Promise<string[]> {
  return apiPost<string[]>(`/wishlist/${encodeURIComponent(productId)}`, {}, AUTH);
}

export function removeFromWishlist(productId: string): Promise<string[]> {
  return apiDelete<string[]>(`/wishlist/${encodeURIComponent(productId)}`, AUTH);
}

/**
 * Move a guest's saved items onto their account.
 *
 * Adding is idempotent server-side — the unique constraint guarantees one row
 * per product — so a merge cannot duplicate anything the account already had.
 */
export async function mergeGuestWishlist(productIds: string[]): Promise<void> {
  for (const productId of productIds) {
    try {
      await addToWishlist(productId);
    } catch {
      /* skip anything that has since been withdrawn */
    }
  }
}

/** Resolve a signed-out visitor's saved ids against the catalogue. */
export async function resolveWishlist(productIds: string[]): Promise<Product[]> {
  if (productIds.length === 0) return [];
  const products = await dataSource.getProductsByIds(productIds);
  // Most recently added first — `productIds` is stored oldest-first.
  return [...products].reverse();
}
