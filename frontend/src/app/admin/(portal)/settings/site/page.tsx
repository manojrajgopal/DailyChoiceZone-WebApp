import type { Metadata } from "next";

import { AdminSiteSettingsView } from "@/components/admin/views/AdminSiteSettingsView";

export const metadata: Metadata = { title: "Site settings" };

export default function Page() {
  return <AdminSiteSettingsView />;
}
