import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminPackingQueueView } from "@/components/admin/views/packing/AdminPackingQueueView";

export const metadata: Metadata = { title: "Packing" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminPackingQueueView />
    </Suspense>
  );
}
