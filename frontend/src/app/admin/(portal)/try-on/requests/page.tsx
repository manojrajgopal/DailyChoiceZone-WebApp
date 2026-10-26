import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminTryOnRequestsView } from "@/components/admin/views/tryon/AdminTryOnRequestsView";

export const metadata: Metadata = { title: "Try-on requests" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminTryOnRequestsView />
    </Suspense>
  );
}
