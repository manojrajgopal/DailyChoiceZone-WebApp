import { cn } from "@/lib/utils/cn";

/**
 * A loading placeholder.
 *
 * The sheen is a child element rather than a background animation so it does
 * not repaint the whole block, and `prefers-reduced-motion` (handled globally)
 * flattens it to a static tint.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block overflow-hidden rounded-card bg-cream-deep",
        "after:absolute after:inset-0 after:-translate-x-full",
        "after:bg-gradient-to-r after:from-transparent after:via-shell/60 after:to-transparent",
        "after:animate-[dcz-shimmer_1.6s_infinite]",
        className,
      )}
    />
  );
}

/** Mirrors ProductCard's proportions so the grid does not jump on load. */
export function ProductCardSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="aspect-[3/4] w-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-1/3" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-1/2" />
      </div>
    </div>
  );
}

export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4"
      aria-busy="true"
      aria-label="Loading products"
    >
      {Array.from({ length: count }, (_, index) => (
        <ProductCardSkeleton key={index} />
      ))}
    </div>
  );
}
