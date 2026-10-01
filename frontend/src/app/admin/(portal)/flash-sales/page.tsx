import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminFlashSalesView } from "@/components/admin/views/growth/AdminFlashSalesView";

export const metadata: Metadata = { title: "Flash sales" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminFlashSalesView />
    </Suspense>
  );
}
