import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminProductsView } from "@/components/admin/views/AdminProductsView";

export const metadata: Metadata = { title: "Products" };

export default function AdminProductsPage() {
  // The list keeps its filters in the address bar (useSearchParams).
  return (
    <Suspense fallback={null}>
      <AdminProductsView />
    </Suspense>
  );
}
