import type { Metadata } from "next";

import { AccountReferralsView } from "@/components/account/AccountReferralsView";

export const metadata: Metadata = {
  title: "Refer a friend",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <AccountReferralsView />;
}
