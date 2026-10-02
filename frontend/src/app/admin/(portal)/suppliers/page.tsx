import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSuppliersView } from "@/components/admin/views/suppliers/AdminSuppliersView";

export const metadata: Metadata = { title: "Suppliers" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSuppliersView />
    </Suspense>
  );
}