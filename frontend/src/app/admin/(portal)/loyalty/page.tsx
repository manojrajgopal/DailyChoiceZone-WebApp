import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminLoyaltyView } from "@/components/admin/views/engagement/AdminLoyaltyView";

export const metadata: Metadata = { title: "Reward points" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminLoyaltyView />
    </Suspense>
  );
}
