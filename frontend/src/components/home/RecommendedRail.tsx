"use client";

import { useEffect, useState } from "react";

import type { Product } from "@/types";

import { ProductRail } from "@/components/products/ProductRail";
import { useHydrated } from "@/hooks/useHydrated";
import { useRecentlyViewedStore } from "@/store/recentlyViewedStore";
import { getRecommendedProducts } from "@/services/productService";

/**
 * "Recommended for you".
 *
 * This is the one homepage rail that cannot be rendered on the server: it is
 * derived from browsing history that only the browser holds. It is therefore a
 * client island inside an otherwise server-rendered page, and it shows
 * skeletons on first paint rather than shifting the layout when it resolves.
 */
export function RecommendedRail({
  limit,
  layout = "grid",
}: {
  limit: number;
  layout?: "rail" | "grid";
}) {
  const hydrated = useHydrated();
  const recentIds = useRecentlyViewedStore((state) => state.productIds);
  const idsKey = recentIds.join(",");

  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!hydrated) return;

    let active = true;
    setIsLoading(true);

    getRecommendedProducts(idsKey === "" ? [] : idsKey.split(","), limit)
      .then((result) => {
        if (active) setProducts(result);
      })
      .catch(() => {
        if (active) setProducts([]);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [idsKey, limit, hydrated]);

  if (!isLoading && products.length === 0) return null;

  return <ProductRail products={products} isLoading={isLoading} layout={layout} />;
}
