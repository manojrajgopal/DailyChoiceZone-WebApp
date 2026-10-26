import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminTryOnSettingsView } from "@/components/admin/views/tryon/AdminTryOnSettingsView";

export const metadata: Metadata = { title: "Try-on settings" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminTryOnSettingsView />
    </Suspense>
  );
}
