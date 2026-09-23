import type { Metadata } from "next";

import { AdminProductsView } from "@/components/admin/views/AdminProductsView";

export const metadata: Metadata = { title: "Products" };

export default function AdminProductsPage() {
  return <AdminProductsView />;
}
