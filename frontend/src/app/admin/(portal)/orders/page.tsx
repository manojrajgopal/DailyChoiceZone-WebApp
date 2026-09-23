import type { Metadata } from "next";

import { AdminOrdersView } from "@/components/admin/views/AdminOrdersView";

export const metadata: Metadata = { title: "Orders" };

export default function Page() {
  return <AdminOrdersView />;
}
