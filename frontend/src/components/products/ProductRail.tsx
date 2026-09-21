import type { Product } from "@/types";

import { ProductCardSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils/cn";

import { ProductCard } from "./ProductCard";

export interface ProductRailProps {
  products: Product[];
  isLoading?: boolean;
  /**
   * `rail` scrolls horizontally on small screens and snaps; `grid` wraps.
   * Rails suit deal strips, grids suit the main homepage sections.
   */
  layout?: "rail" | "grid";
  prioritiseFirstRow?: boolean;
  className?: string;
}

/**
 * A homepage product row.
 *
 * The horizontal variant uses CSS scroll-snap rather than a carousel library:
 * it is natively swipeable, keyboard-scrollable, needs no JavaScript, and does
 * not hide products behind arrows the way a paged carousel does.
 */
export function ProductRail({
  products,
  isLoading = false,
  layout = "grid",
  prioritiseFirstRow = false,
  className,
}: ProductRailProps) {
  if (isLoading) {
    return (
      <div
        className={cn("grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-6", className)}
        aria-busy="true"
        aria-label="Loading products"
      >
        {Array.from({ length: 6 }, (_, index) => (
          <ProductCardSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (products.length === 0) return null;

  if (layout === "rail") {
    return (
      <ul
        className={cn(
          "no-scrollbar -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4",
          "sm:mx-0 sm:px-0",
          className,
        )}
      >
        {products.map((product, index) => (
          <li
            key={product.id}
            className="w-[calc(50%-0.5rem)] shrink-0 snap-start sm:w-[calc(33.333%-0.667rem)] lg:w-[calc(16.666%-0.834rem)]"
          >
            <ProductCard
              product={product}
              sizes="(min-width: 1024px) 16vw, (min-width: 640px) 32vw, 48vw"
              priority={prioritiseFirstRow && index < 4}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-5 lg:grid-cols-6",
        className,
      )}
    >
      {products.map((product, index) => (
        <ProductCard
          key={product.id}
          product={product}
          sizes="(min-width: 1024px) 16vw, (min-width: 640px) 32vw, 48vw"
          priority={prioritiseFirstRow && index < 4}
        />
      ))}
    </div>
  );
}
