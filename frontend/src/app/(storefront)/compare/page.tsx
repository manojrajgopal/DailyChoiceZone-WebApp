import type { Metadata } from "next";

import { CompareView } from "@/components/compare/CompareView";

export const metadata: Metadata = {
  title: "Compare products",
  description: "Compare Daily Choice Zone products side by side: price, sizes, materials and more.",
  robots: { index: false, follow: true },
};

export default function ComparePage() {
  return <CompareView />;
}
