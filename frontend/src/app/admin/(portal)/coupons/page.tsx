import type { Metadata } from "next";

import { AdminCouponsView } from "@/components/admin/views/AdminCouponsView";

export const metadata: Metadata = { title: "Coupons" };

export default function Page() {
  return <AdminCouponsView />;
}
