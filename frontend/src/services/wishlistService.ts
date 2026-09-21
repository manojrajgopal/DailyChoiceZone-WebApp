import type { Product } from "@/types";

import { dataSource } from "./data-source.instance";

/**
 * The wishlist stores ids only; products are resolved on read.
 *
 * That keeps prices and stock current — a wishlist is often looked at weeks
 * after items were added, which is exactly when a cached copy would be wrong.
 *
 * Future: `POST /wishlist` and `DELETE /wishlist/:id` replace the local store,
 * and this function becomes `GET /wishlist`.
 */
export async function resolveWishlist(productIds: string[]): Promise<Product[]> {
  if (productIds.length === 0) return [];
  const products = await dataSource.getProductsByIds(productIds);
  // Most recently added first — `productIds` is stored oldest-first.
  return [...products].reverse();
}
