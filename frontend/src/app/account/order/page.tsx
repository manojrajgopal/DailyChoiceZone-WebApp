import type { Metadata } from "next";
import { Suspense } from "react";

import { OrderDetailView } from "@/components/account/OrderDetailView";
import { Skeleton } from "@/components/ui/Skeleton";

export const metadata: Metadata = {
  title: "Order details",
  description: "The items, delivery status and payment for your order.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/**
 * A single order, addressed as `/account/order?number=DCZ-XXXXXX`.
 *
 * The order number is a query parameter rather than a path segment because
 * this site is exported as static HTML: a dynamic segment would need every
 * possible value enumerated at build time, and order numbers only come into
 * existence at runtime. One page is built, and it reads the number on load.
 */
export default function OrderPage() {
  return (
    <Suspense
      fallback={
        <div className="page-shell py-10">
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <OrderDetailView />
    </Suspense>
  );
}
