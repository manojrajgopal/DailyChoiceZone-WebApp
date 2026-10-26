import type { Metadata } from "next";

import { TryOnBrowseView } from "@/components/tryon/TryOnBrowseView";

export const metadata: Metadata = {
  title: "Virtual try-on",
  description: "See clothes on you before you buy: browse everything you can try on virtually.",
  alternates: { canonical: "/try-on" },
};

/** Server wrapper for metadata; what can be tried on loads client-side. */
export default function TryOnPage() {
  return <TryOnBrowseView />;
}
