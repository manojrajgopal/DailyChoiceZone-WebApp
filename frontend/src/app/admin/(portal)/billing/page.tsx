import type { Metadata } from "next";

import { AdminBillingView } from "@/components/admin/views/AdminBillingView";

export const metadata: Metadata = { title: "Billing" };

export default function Page() {
  return <AdminBillingView />;
}
