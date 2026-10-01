import type { Metadata } from "next";

import { AccountRewardsView } from "@/components/account/AccountRewardsView";

export const metadata: Metadata = {
  title: "Reward points",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <AccountRewardsView />;
}
