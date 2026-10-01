import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminReconciliationView } from "@/components/admin/views/operations/AdminReconciliationView";

export const metadata: Metadata = { title: "Payment reconciliation" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminReconciliationView />
    </Suspense>
  );
}
