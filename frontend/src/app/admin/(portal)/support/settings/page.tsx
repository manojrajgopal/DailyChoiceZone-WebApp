import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSupportSettingsView } from "@/components/admin/views/support/AdminSupportSettingsView";

export const metadata: Metadata = { title: "Support setup" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSupportSettingsView />
    </Suspense>
  );
}
