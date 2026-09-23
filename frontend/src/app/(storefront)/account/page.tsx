import type { Metadata } from "next";

import { ProfileView } from "@/components/account/ProfileView";

export const metadata: Metadata = {
  title: "Your profile",
  description: "Your Daily Choice Zone profile, orders and saved addresses.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/** Server wrapper for metadata; the account area itself is client-side. */
export default function Page() {
  return <ProfileView />;
}
