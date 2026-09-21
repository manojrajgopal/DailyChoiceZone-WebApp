import type { Product } from "@/types";

import { ProductCardSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils/cn";

import { ProductCard } from "./ProductCard";

export interface ProductGridProps {
  products: Product[];
  /** Replaces the grid with skeletons at the same proportions. */
  isLoading?: boolean;
  skeletonCount?: number;
  /**
   * Columns at the largest breakpoint. Listing pages use 4; a narrower
   * context such as a collection sidebar can drop to 3.
   */
  columns?: 3 | 4;
  /** Eagerly load the first row's images. On for above-the-fold grids. */
  prioritiseFirstRow?: boolean;
  className?: string;
}

/**
 * The responsive product grid: two columns on mobile, three on tablet, four on
 * desktop — the mobile pair being deliberate, since a single wide card per row
 * makes a catalogue feel much smaller than it is.
 */
export function ProductGrid({
  products,
  isLoading = false,
  skeletonCount = 8,
  columns = 4,
  prioritiseFirstRow = false,
  className,
}: ProductGridProps) {
  const grid = cn(
    "grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-5 sm:gap-y-10",
    columns === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3",
    className,
  );

  const sizes =
    columns === 4
      ? "(min-width: 1024px) 24vw, (min-width: 640px) 32vw, 48vw"
      : "(min-width: 640px) 32vw, 48vw";

  if (isLoading) {
    return (
      <div className={grid} aria-busy="true" aria-label="Loading products">
        {Array.from({ length: skeletonCount }, (_, index) => (
          <ProductCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  return (
    <div className={grid}>
      {products.map((product, index) => (
        <ProductCard
          key={product.id}
          product={product}
          sizes={sizes}
          priority={prioritiseFirstRow && index < columns}
        />
      ))}
    </div>
  );
}
