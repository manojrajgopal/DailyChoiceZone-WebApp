import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminOrderDetailView } from "@/components/admin/views/AdminOrderDetailView";

export const metadata: Metadata = { title: "Order details" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminOrderDetailView />
    </Suspense>
  );
}
