import type { Metadata } from "next";

import { SupportTicketsView } from "@/components/account/SupportTicketsView";

export const metadata: Metadata = {
  title: "Support requests",
  description: "Your requests to the Daily Choice Zone support team, and our replies.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <SupportTicketsView />;
}
