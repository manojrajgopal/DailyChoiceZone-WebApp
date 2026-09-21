import type { Metadata } from "next";

import { CartView } from "@/components/cart/CartView";

export const metadata: Metadata = {
  title: "Shopping bag",
  description: "Review the items in your Daily Choice Zone bag and head to checkout.",
  // Personal, and never useful in search results.
  robots: { index: false, follow: false },
};

/**
 * A thin server wrapper so the bag can carry real metadata.
 *
 * The bag itself lives in local storage and must be a client component, and a
 * client component cannot export `metadata` — hence the split.
 */
export default function CartPage() {
  return <CartView />;
}
