import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminPurchaseOrdersView } from "@/components/admin/views/suppliers/AdminPurchaseOrdersView";

export const metadata: Metadata = { title: "Purchase orders" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminPurchaseOrdersView />
    </Suspense>
  );
}