import type { Metadata } from "next";

import { AdminInventoryView } from "@/components/admin/views/AdminInventoryView";

export const metadata: Metadata = { title: "Inventory" };

export default function Page() {
  return <AdminInventoryView />;
}
