import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSettingsView } from "@/components/admin/views/AdminSettingsView";

export const metadata: Metadata = { title: "Store settings" };

export default function Page() {
  // The section is read from the address, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <AdminSettingsView />
    </Suspense>
  );
}
