import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSiteSettingsView } from "@/components/admin/views/AdminSiteSettingsView";

export const metadata: Metadata = { title: "Site settings" };

export default function Page() {
  // The section is read from the address, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <AdminSiteSettingsView />
    </Suspense>
  );
}
