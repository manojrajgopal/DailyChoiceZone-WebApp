import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminCustomerDetailView } from "@/components/admin/views/AdminCustomerDetailView";

export const metadata: Metadata = { title: "Customer" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminCustomerDetailView />
    </Suspense>
  );
}
