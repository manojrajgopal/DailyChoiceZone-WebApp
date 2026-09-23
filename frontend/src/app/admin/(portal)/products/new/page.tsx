import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminProductForm } from "@/components/admin/views/AdminProductForm";

export const metadata: Metadata = { title: "Add product" };

export default function AdminNewProductPage() {
  return (
    <Suspense fallback={null}>
      <AdminProductForm mode="create" />
    </Suspense>
  );
}
