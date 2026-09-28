import type { Metadata } from "next";

import { AdminContentSettingsView } from "@/components/admin/views/AdminContentSettingsView";

export const metadata: Metadata = { title: "Content settings" };

export default function Page() {
  return <AdminContentSettingsView />;
}
