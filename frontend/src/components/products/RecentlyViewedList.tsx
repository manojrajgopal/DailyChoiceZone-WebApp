"use client";

import { useState } from "react";
import { X } from "lucide-react";

import { ProductCard } from "@/components/products/ProductCard";
import { EmptyState, ErrorState } from "@/components/common/States";
import { Button } from "@/components/ui/Button";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { ProductCardSkeleton } from "@/components/ui/Skeleton";
import { useRecentlyViewed } from "@/hooks/useRecentlyViewed";
import { clickTracker } from "@/lib/discovery/tracking";

const PAGE = 24;

/**
 * Every recently viewed product, newest first, each removable on its own —
 * for the account page and the guest page alike. Products withdrawn from sale
 * since they were viewed are not listed; ones that sold out are, marked so by
 * their card.
 */
export function RecentlyViewedList() {
  const [limit, setLimit] = useState(PAGE);
  const { products, total, isLoading, isEmpty, failed, clear, remove, refresh } = useRecentlyViewed({ limit });
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  if (failed) {
    return <ErrorState description="We couldn't load your recently viewed products." onRetry={refresh} />;
  }

  if (isLoading && products.length === 0) {
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true"
        aria-label="Loading recently viewed products">
        {Array.from({ length: 8 }, (_, index) => <ProductCardSkeleton key={index} />)}
      </div>
    );
  }

  if (isEmpty || products.length === 0) {
    return (
      <EmptyState
        title="Nothing viewed yet"
        description="Products you look at will appear here, so you can find them again."
        action={{ label: "Start browsing", href: "/shop" }}
      />
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500" aria-live="polite">
          {total} {total === 1 ? "product" : "products"}
        </p>
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          Clear all
        </Button>
      </div>

      <ul
        className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4"
        onClickCapture={clickTracker("recently_viewed_click", "recently-viewed:list")}
      >
        {products.map((product) => (
          <li key={product.id} className="relative">
            <ProductCard product={product} sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw" />
            <button
              type="button"
              onClick={async () => {
                setRemoving(product.id);
                await remove(product.id);
                setRemoving(null);
              }}
              disabled={removing === product.id}
              aria-label={`Remove ${product.name} from recently viewed`}
              className="absolute left-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-pill bg-shell/90 text-ink shadow-sm transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-50"
            >
              <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      {total > products.length ? (
        <div className="mt-10 flex justify-center">
          <Button variant="outline" onClick={() => setLimit((current) => current + PAGE)} disabled={isLoading}>
            {isLoading ? "Loading…" : "Show more"}
          </Button>
        </div>
      ) : null}

      <ConfirmModal
        open={confirming}
        onOpenChange={setConfirming}
        title="Clear recently viewed?"
        message="Every product will be removed from this list. This can't be undone."
        confirmLabel="Clear all"
        onConfirm={clear}
      />
    </div>
  );
}
