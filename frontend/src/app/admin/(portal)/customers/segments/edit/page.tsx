import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSegmentBuilder } from "@/components/admin/views/segments/AdminSegmentBuilder";

export const metadata: Metadata = { title: "Segment builder" };

/** `/admin/customers/segments/edit` (new) and `?id=3` (edit) — a query parameter, so the static export needs no id at build time. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSegmentBuilder />
    </Suspense>
  );
}
