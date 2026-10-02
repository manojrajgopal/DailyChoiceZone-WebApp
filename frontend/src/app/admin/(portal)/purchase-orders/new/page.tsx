import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminNewPurchaseOrderView } from "@/components/admin/views/suppliers/AdminPurchaseOrderForm";

export const metadata: Metadata = { title: "New purchase order" };

/** `/admin/purchase-orders/new?supplier=SUP001` (supplier optional). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminNewPurchaseOrderView />
    </Suspense>
  );
}