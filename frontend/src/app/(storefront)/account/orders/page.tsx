import type { Metadata } from "next";

import { OrdersView } from "@/components/account/OrdersView";

export const metadata: Metadata = {
  title: "Your orders",
  description: "Track and review your Daily Choice Zone orders.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <OrdersView />;
}
