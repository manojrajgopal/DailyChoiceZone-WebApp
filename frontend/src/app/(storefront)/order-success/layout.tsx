import type { Metadata } from "next";

export const metadata: Metadata = {
  // "Your order", not "Order confirmed": the same page shows an order that was
  // placed but not yet paid for, and a tab title that says confirmed while the
  // heading says payment is due is the kind of small lie people notice.
  title: "Your order",
  description: "Your Daily Choice Zone order has been placed.",
  robots: { index: false, follow: false },
};

export default function OrderSuccessLayout({ children }: { children: React.ReactNode }) {
  return children;
}
