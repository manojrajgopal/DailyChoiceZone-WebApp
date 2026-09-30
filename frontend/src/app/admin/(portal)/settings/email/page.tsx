import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminEmailSettingsView } from "@/components/admin/views/AdminEmailSettingsView";

export const metadata: Metadata = { title: "Email" };

export default function Page() {
  // The section is read from the address, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <AdminEmailSettingsView />
    </Suspense>
  );
}
