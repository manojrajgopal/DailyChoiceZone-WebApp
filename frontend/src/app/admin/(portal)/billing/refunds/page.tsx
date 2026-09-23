import type { Metadata } from "next";

import { AdminRefundsView } from "@/components/admin/views/AdminRefundsView";

export const metadata: Metadata = { title: "Refunds" };

export default function Page() {
  return <AdminRefundsView />;
}
