import type { Metadata } from "next";

import { AdminInvoiceDetailView } from "@/components/admin/views/AdminInvoiceDetailView";

export const metadata: Metadata = { title: "Invoice" };

export default function Page() {
  return <AdminInvoiceDetailView />;
}
