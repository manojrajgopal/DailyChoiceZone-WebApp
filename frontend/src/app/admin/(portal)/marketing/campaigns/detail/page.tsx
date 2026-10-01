import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminCampaignDetailView } from "@/components/admin/views/messaging/AdminCampaignsView";

export const metadata: Metadata = { title: "Campaign" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminCampaignDetailView />
    </Suspense>
  );
}
