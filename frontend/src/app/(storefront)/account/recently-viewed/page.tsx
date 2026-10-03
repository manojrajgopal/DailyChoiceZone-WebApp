import type { Metadata } from "next";

import { AccountRecentlyViewedView } from "@/components/account/AccountRecentlyViewedView";

export const metadata: Metadata = {
  title: "Recently viewed",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <AccountRecentlyViewedView />;
}
