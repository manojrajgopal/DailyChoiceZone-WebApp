import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminPackingJobView } from "@/components/admin/views/packing/AdminPackingJobView";

export const metadata: Metadata = { title: "Pack order" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminPackingJobView />
    </Suspense>
  );
}
