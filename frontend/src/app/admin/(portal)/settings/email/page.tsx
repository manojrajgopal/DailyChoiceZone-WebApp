import type { Metadata } from "next";

import { AdminEmailSettingsView } from "@/components/admin/views/AdminEmailSettingsView";

export const metadata: Metadata = { title: "Email" };

export default function Page() {
  return <AdminEmailSettingsView />;
}
