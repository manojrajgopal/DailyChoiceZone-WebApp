import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminTryOnRequestDetailView } from "@/components/admin/views/tryon/AdminTryOnRequestsView";

export const metadata: Metadata = { title: "Try-on request" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminTryOnRequestDetailView />
    </Suspense>
  );
}
