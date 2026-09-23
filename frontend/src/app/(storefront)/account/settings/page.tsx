import type { Metadata } from "next";

import { SettingsView } from "@/components/account/SettingsView";

export const metadata: Metadata = {
  title: "Settings",
  description: "Notification preferences and locally stored data.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <SettingsView />;
}
