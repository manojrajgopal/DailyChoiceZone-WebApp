"use client";

import { ProductRail } from "@/components/products/ProductRail";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useRecentlyViewed, useRecordProductView } from "@/hooks/useRecentlyViewed";

/**
 * "Recently viewed".
 *
 * Renders nothing at all until there is history worth showing, so a first-time
 * visitor never sees an empty heading. `recordId` lets the product page record
 * its own view and read the rail from a single mount.
 */
export function RecentlyViewedRail({
  recordId,
  excludeId,
  limit = 6,
}: {
  /** Product to record as viewed. Pass on a product detail page. */
  recordId?: string;
  /** Product to keep out of the rail — usually the same id. */
  excludeId?: string;
  limit?: number;
}) {
  useRecordProductView(recordId);
  const { products, isLoading } = useRecentlyViewed({ excludeId, limit });

  if (!isLoading && products.length === 0) return null;
  // Avoid a heading above six skeletons on a first visit with no history.
  if (isLoading) return null;

  return (
    <section aria-labelledby="recently-viewed-heading" className="page-shell">
      <SectionHeader
        id="recently-viewed-heading"
        title="Recently viewed"
        subtitle="Pick up where you left off"
        className="mb-7"
      />
      <ProductRail products={products} layout="rail" />
    </section>
  );
}
