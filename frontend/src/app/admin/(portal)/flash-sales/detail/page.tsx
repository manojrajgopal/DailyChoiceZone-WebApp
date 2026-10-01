import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminFlashSaleDetailView } from "@/components/admin/views/growth/AdminFlashSalesView";

export const metadata: Metadata = { title: "Flash sale" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminFlashSaleDetailView />
    </Suspense>
  );
}
