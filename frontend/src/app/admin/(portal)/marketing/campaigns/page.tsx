import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminCampaignsView } from "@/components/admin/views/messaging/AdminCampaignsView";

export const metadata: Metadata = { title: "Campaigns" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminCampaignsView />
    </Suspense>
  );
}
