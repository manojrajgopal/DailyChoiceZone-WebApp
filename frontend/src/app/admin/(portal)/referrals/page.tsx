import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminReferralsView } from "@/components/admin/views/growth/AdminReferralsView";

export const metadata: Metadata = { title: "Referrals" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminReferralsView />
    </Suspense>
  );
}
