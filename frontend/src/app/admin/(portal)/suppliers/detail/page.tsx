import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSupplierDetailView } from "@/components/admin/views/suppliers/AdminSupplierDetailView";

export const metadata: Metadata = { title: "Supplier" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSupplierDetailView />
    </Suspense>
  );
}