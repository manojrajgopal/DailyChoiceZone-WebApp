import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminBundleDetailView } from "@/components/admin/views/growth/AdminBundlesView";

export const metadata: Metadata = { title: "Bundle" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminBundleDetailView />
    </Suspense>
  );
}
