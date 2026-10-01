import type { Metadata } from "next";

import { AccountWalletView } from "@/components/account/AccountWalletView";

export const metadata: Metadata = {
  title: "Gift cards & credit",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <AccountWalletView />;
}
