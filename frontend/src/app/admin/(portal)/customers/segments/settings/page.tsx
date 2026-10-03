import type { Metadata } from "next";

import { AdminSegmentSettingsView } from "@/components/admin/views/segments/AdminSegmentSettingsView";

export const metadata: Metadata = { title: "RFM settings" };

export default function Page() {
  return <AdminSegmentSettingsView />;
}
