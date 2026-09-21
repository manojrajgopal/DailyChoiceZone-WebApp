import type { Metadata } from "next";

import { WishlistView } from "@/components/wishlist/WishlistView";

export const metadata: Metadata = {
  title: "Wishlist",
  description: "Items you have saved at Daily Choice Zone, kept for later.",
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the wishlist itself is client-side. */
export default function WishlistPage() {
  return <WishlistView />;
}
