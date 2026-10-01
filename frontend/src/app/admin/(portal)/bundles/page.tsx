import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminBundlesView } from "@/components/admin/views/growth/AdminBundlesView";

export const metadata: Metadata = { title: "Bundles" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminBundlesView />
    </Suspense>
  );
}
