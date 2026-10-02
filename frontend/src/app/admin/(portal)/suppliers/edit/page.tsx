import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSupplierForm } from "@/components/admin/views/suppliers/AdminSupplierForm";

export const metadata: Metadata = { title: "Edit supplier" };

/** `/admin/suppliers/edit?id=SUP001` — a query parameter, so the static export needs no id at build time. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSupplierForm mode="edit" />
    </Suspense>
  );
}