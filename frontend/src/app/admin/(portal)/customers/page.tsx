import type { Metadata } from "next";

import { AdminCustomersView } from "@/components/admin/views/AdminCustomersView";

export const metadata: Metadata = { title: "Customers" };

export default function Page() {
  return <AdminCustomersView />;
}
