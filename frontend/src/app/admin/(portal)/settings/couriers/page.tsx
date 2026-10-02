import type { Metadata } from "next";

import { AdminCouriersView } from "@/components/admin/views/shipping/AdminCouriersView";

export const metadata: Metadata = { title: "Couriers" };

export default function Page() {
  return <AdminCouriersView />;
}
