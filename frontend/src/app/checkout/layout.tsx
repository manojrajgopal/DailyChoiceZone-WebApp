import type { Metadata } from "next";

/**
 * Checkout metadata.
 *
 * Applied at the layout so all four steps share it. Every step is a client
 * component (the bag and the in-progress order live in local storage), and a
 * client component cannot export `metadata` itself.
 */
export const metadata: Metadata = {
  title: "Checkout",
  description: "Complete your Daily Choice Zone order.",
  robots: { index: false, follow: false },
};

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return children;
}
