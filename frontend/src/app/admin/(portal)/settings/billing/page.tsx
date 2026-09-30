import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminBillingSettingsView } from "@/components/admin/views/AdminBillingSettingsView";

export const metadata: Metadata = { title: "Billing settings" };

export default function Page() {
  // The section is read from the address, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <AdminBillingSettingsView />
    </Suspense>
  );
}
