import type { Metadata } from "next";

import { BundlesView } from "@/components/growth/Bundles";

export const metadata: Metadata = {
  title: "Bundles & combos",
  description: "Pieces that go together at Daily Choice Zone, for less than buying them one by one.",
};

export default function Page() {
  return <BundlesView />;
}
