import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSegmentDetailView } from "@/components/admin/views/segments/AdminSegmentDetailView";

export const metadata: Metadata = { title: "Segment" };

/** `/admin/customers/segments/detail?id=3` — a query parameter, so the static export needs no id at build time. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSegmentDetailView />
    </Suspense>
  );
}
