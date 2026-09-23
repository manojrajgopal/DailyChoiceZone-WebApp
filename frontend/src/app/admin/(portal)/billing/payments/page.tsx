import type { Metadata } from "next";

import { AdminPaymentsView } from "@/components/admin/views/AdminPaymentsView";

export const metadata: Metadata = { title: "Payments" };

export default function Page() {
  return <AdminPaymentsView />;
}
