import type { Metadata } from "next";

import { AddressesView } from "@/components/account/AddressesView";

export const metadata: Metadata = {
  title: "Saved addresses",
  description: "Manage the delivery addresses offered at checkout.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <AddressesView />;
}
