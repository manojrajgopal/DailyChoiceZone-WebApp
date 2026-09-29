import type { Metadata } from "next";

import { AccountMembershipView } from "@/components/account/AccountMembershipView";

export const metadata: Metadata = {
  title: "Membership",
  description: "Your membership, its benefits and what it has saved you.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <AccountMembershipView />;
}
