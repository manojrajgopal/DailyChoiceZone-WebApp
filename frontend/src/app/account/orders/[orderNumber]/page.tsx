import type { Metadata } from "next";

import { OrderDetailView } from "@/components/account/OrderDetailView";

export const metadata: Metadata = {
  title: "Order details",
  description: "The items, delivery status and payment for your order.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <OrderDetailView />;
}
