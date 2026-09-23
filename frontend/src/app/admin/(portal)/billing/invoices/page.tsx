import type { Metadata } from "next";

import { AdminInvoicesView } from "@/components/admin/views/AdminInvoicesView";

export const metadata: Metadata = { title: "Invoices" };

export default function Page() {
  return <AdminInvoicesView />;
}
