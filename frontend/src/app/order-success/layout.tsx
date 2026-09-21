import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Order confirmed",
  description: "Your Daily Choice Zone order has been placed.",
  robots: { index: false, follow: false },
};

export default function OrderSuccessLayout({ children }: { children: React.ReactNode }) {
  return children;
}
