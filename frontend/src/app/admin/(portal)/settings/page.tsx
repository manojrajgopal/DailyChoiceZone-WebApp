import type { Metadata } from "next";

import { AdminSettingsView } from "@/components/admin/views/AdminSettingsView";

export const metadata: Metadata = { title: "Store settings" };

export default function Page() {
  return <AdminSettingsView />;
}
