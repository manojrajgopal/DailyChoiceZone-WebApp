import type { Metadata } from "next";

import { AccountSavedForLaterView } from "@/components/account/AccountSavedForLaterView";

export const metadata: Metadata = {
  title: "Saved for later",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <AccountSavedForLaterView />;
}
