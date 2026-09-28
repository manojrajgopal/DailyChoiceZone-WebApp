import type { Metadata } from "next";

import { AdminNavigationSettingsView } from "@/components/admin/views/AdminNavigationSettingsView";

export const metadata: Metadata = { title: "Navigation settings" };

export default function Page() {
  return <AdminNavigationSettingsView />;
}
