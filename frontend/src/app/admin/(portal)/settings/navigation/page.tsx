import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminNavigationSettingsView } from "@/components/admin/views/AdminNavigationSettingsView";

export const metadata: Metadata = { title: "Navigation settings" };

export default function Page() {
  // The section is read from the address, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <AdminNavigationSettingsView />
    </Suspense>
  );
}
