import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminReturnDetailView } from "@/components/admin/views/AdminReturnsView";

export const metadata: Metadata = { title: "Return details" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminReturnDetailView />
    </Suspense>
  );
}
