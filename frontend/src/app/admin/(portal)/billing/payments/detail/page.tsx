import type { Metadata } from "next";

import { AdminPaymentDetailView } from "@/components/admin/views/AdminPaymentDetailView";

export const metadata: Metadata = { title: "Payment" };

export default function Page() {
  return <AdminPaymentDetailView />;
}
