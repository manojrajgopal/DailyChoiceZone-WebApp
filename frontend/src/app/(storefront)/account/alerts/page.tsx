import type { Metadata } from "next";

import { AccountAlertsView } from "@/components/account/AccountAlertsView";

export const metadata: Metadata = {
  title: "Stock & price alerts",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <AccountAlertsView />;
}
