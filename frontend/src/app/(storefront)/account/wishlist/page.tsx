import type { Metadata } from "next";

import { AccountWishlistView } from "@/components/account/AccountWishlistView";

export const metadata: Metadata = {
  title: "Wishlist",
  description: "The products you have saved for later.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <AccountWishlistView />;
}
