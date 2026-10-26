import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminTryOnAllocationsView } from "@/components/admin/views/tryon/AdminTryOnAllocationsView";

export const metadata: Metadata = { title: "Try-on access & allocations" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminTryOnAllocationsView />
    </Suspense>
  );
}
