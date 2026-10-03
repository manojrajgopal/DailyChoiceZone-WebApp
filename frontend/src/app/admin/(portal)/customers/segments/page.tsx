import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSegmentsView } from "@/components/admin/views/segments/AdminSegmentsView";

export const metadata: Metadata = { title: "Segments" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSegmentsView />
    </Suspense>
  );
}
