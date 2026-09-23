import type { Metadata } from "next";

import { AdminBillingSettingsView } from "@/components/admin/views/AdminBillingSettingsView";

export const metadata: Metadata = { title: "Billing settings" };

export default function Page() {
  return <AdminBillingSettingsView />;
}
