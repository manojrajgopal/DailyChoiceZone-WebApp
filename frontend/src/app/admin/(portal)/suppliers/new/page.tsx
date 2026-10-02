import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSupplierForm } from "@/components/admin/views/suppliers/AdminSupplierForm";

export const metadata: Metadata = { title: "New supplier" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSupplierForm mode="create" />
    </Suspense>
  );
}