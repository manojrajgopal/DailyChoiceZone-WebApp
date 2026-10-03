"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ShoppingBag } from "lucide-react";

import type { Product } from "@/types";

import { ProductCard } from "@/components/products/ProductCard";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { ProductCardSkeleton } from "@/components/ui/Skeleton";
import { useAddToCart } from "@/hooks/useCart";
import { clickTracker, useImpressions } from "@/lib/discovery/tracking";
import { productHref } from "@/lib/products/colourImages";
import { getRecommendations, type RecommendationType } from "@/services/discoveryService";

/**
 * A recommendation rail on the product page: "You may also like", "Frequently
 * bought together", "Similar products".
 *
 * The list is the server's (`/products/{id}/related?type=`): the store's own
 * choices first, then what scores closest, never the product itself or
 * anything unpublished, sold-out items last. `initialProducts` is the list the
 * page already rendered on the server — given it, the rail asks for nothing.
 *
 * Measured through the store's analytics events: shown (once it scrolls into
 * view), clicked, and added to the bag from here — which is what lets a
 * purchase be credited to the rail.
 */
export function RecommendationRail({
  productId,
  type,
  title,
  subtitle,
  placement,
  initialProducts,
  limit = 6,
  viewAllHref,
}: {
  productId: string;
  type: RecommendationType;
  title: string;
  subtitle?: string;
  /** e.g. "pdp-related"; recorded as `rec:<placement>`. */
  placement: string;
  initialProducts?: Product[];
  limit?: number;
  viewAllHref?: string;
}) {
  const [products, setProducts] = useState<Product[] | null>(initialProducts ?? null);
  const source = `rec:${placement}`;

  useEffect(() => {
    if (initialProducts) return;
    let active = true;
    getRecommendations(productId, type, limit)
      .then((items) => active && setProducts(items))
      // A rail that can't load is left out — the page is complete without it.
      .catch(() => active && setProducts([]));
    return () => {
      active = false;
    };
  }, [productId, type, limit, initialProducts]);

  const ref = useImpressions(source, (products ?? []).map((p) => p.id));
  const headingId = `rec-${placement}-heading`;

  if (products !== null && products.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="page-shell">
      <SectionHeader id={headingId} title={title} subtitle={subtitle} viewAllHref={viewAllHref} className="mb-7" />
      {products === null ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-6" aria-busy="true"
          aria-label={`Loading ${title.toLowerCase()}`}>
          {Array.from({ length: Math.min(limit, 6) }, (_, index) => <ProductCardSkeleton key={index} />)}
        </div>
      ) : (
        <div ref={ref} onClickCapture={clickTracker("recommendation_click", source)}>
          <ul className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 sm:mx-0 sm:scroll-px-0 sm:px-0">
            {products.map((product) => (
              <li
                key={product.id}
                className="flex w-[calc(50%-0.5rem)] shrink-0 snap-start flex-col sm:w-[calc(33.333%-0.667rem)] lg:w-[calc(16.666%-0.834rem)]"
              >
                <ProductCard product={product} sizes="(min-width: 1024px) 16vw, (min-width: 640px) 32vw, 48vw" />
                <QuickAdd product={product} source={source} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Add to bag from the rail — straight in when there's nothing to choose, otherwise to the product to choose. */
function QuickAdd({ product, source }: { product: Product; source: string }) {
  const add = useAddToCart();
  const [busy, setBusy] = useState(false);

  if (product.stock <= 0) {
    return <p className="mt-2 text-xs text-ink-400">Out of stock</p>;
  }
  if (product.sizes.length > 0) {
    return (
      <Link
        href={productHref(product, null)}
        className="mt-2 inline-flex h-9 items-center justify-center rounded-control border border-ink-200 text-xs font-medium text-ink transition-colors hover:border-ink"
      >
        Choose size
      </Link>
    );
  }
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy}
      aria-label={`Add ${product.name} to bag`}
      onClick={async () => {
        setBusy(true);
        try {
          await add(product, { color: product.colors[0]?.name ?? null, quantity: 1, source });
        } finally {
          setBusy(false);
        }
      }}
      className="mt-2 inline-flex h-9 items-center justify-center gap-1.5 rounded-control border border-ink bg-ink text-xs font-medium text-cream transition-colors hover:bg-ink-700 disabled:opacity-60"
    >
      <ShoppingBag className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      {busy ? "Adding…" : "Add to bag"}
    </button>
  );
}
