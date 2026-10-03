"use client";

import { useState } from "react";

import { ProductRail } from "@/components/products/ProductRail";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { useRecentlyViewed, useRecordProductView } from "@/hooks/useRecentlyViewed";
import { useCustomerStatus } from "@/hooks/useSession";
import { clickTracker } from "@/lib/discovery/tracking";
import { cn } from "@/lib/utils/cn";

/**
 * "Recently viewed".
 *
 * Renders nothing at all until there is history worth showing, so a first-time
 * visitor never sees an empty heading — on the product page and the homepage
 * alike. `recordId` lets the product page record its own view and read the
 * rail from a single mount.
 */
export function RecentlyViewedRail({
  recordId,
  excludeId,
  limit = 6,
  placement = "pdp",
  className,
}: {
  /** Product to record as viewed. Pass on a product detail page. */
  recordId?: string;
  /** Product to keep out of the rail — usually the same id. */
  excludeId?: string;
  limit?: number;
  /** Which page the rail is on, for the click analytics. */
  placement?: string;
  className?: string;
}) {
  useRecordProductView(recordId);
  const { products, total, isLoading, clear } = useRecentlyViewed({ excludeId, limit });
  const { isSignedIn } = useCustomerStatus();
  const [confirming, setConfirming] = useState(false);

  // Avoid a heading above six skeletons on a first visit with no history.
  if (isLoading || products.length === 0) return null;

  return (
    <section aria-labelledby="recently-viewed-heading" className={cn("page-shell", className)}>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <SectionHeader
          id="recently-viewed-heading"
          title="Recently viewed"
          subtitle="Pick up where you left off"
          viewAllHref={total > products.length ? (isSignedIn ? "/account/recently-viewed" : "/recently-viewed")
            : undefined}
          className="flex-1"
        />
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="label-wide text-ink-500 underline-offset-2 transition-colors hover:text-danger hover:underline"
        >
          Clear all
        </button>
      </div>
      <div onClickCapture={clickTracker("recently_viewed_click", `recently-viewed:${placement}`)}>
        <ProductRail products={products} layout="rail" />
      </div>
      <ConfirmModal
        open={confirming}
        onOpenChange={setConfirming}
        title="Clear recently viewed?"
        message="The products you've looked at will no longer be listed here. This can't be undone."
        confirmLabel="Clear all"
        onConfirm={clear}
      />
    </section>
  );
}
