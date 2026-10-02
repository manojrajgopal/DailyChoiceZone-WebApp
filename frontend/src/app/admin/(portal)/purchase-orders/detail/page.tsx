import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminPurchaseOrderDetailView } from "@/components/admin/views/suppliers/AdminPurchaseOrderDetailView";

export const metadata: Metadata = { title: "Purchase order" };

/** `/admin/purchase-orders/detail?id=POR001`; receiving opens in a dialog here. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminPurchaseOrderDetailView />
    </Suspense>
  );
}