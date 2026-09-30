import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminContentSettingsView } from "@/components/admin/views/AdminContentSettingsView";

export const metadata: Metadata = { title: "Content settings" };

export default function Page() {
  // The section is read from the address, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <AdminContentSettingsView />
    </Suspense>
  );
}
