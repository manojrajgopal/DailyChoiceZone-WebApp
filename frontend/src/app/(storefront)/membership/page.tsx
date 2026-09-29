import type { Metadata } from "next";

import { MembershipView } from "@/components/membership/MembershipView";

export const metadata: Metadata = {
  title: "Membership",
  description:
    "Free delivery, an extra saving on every order, longer returns and early access to sales — choose the membership plan that suits you.",
  alternates: { canonical: "/membership" },
};

/** Server wrapper for metadata; plans and the shopper's own membership load client-side. */
export default function MembershipPage() {
  return <MembershipView />;
}
