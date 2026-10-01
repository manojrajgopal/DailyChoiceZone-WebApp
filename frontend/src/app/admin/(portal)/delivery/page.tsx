import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminPincodesView } from "@/components/admin/views/operations/AdminPincodesView";

export const metadata: Metadata = { title: "Delivery pincodes" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminPincodesView />
    </Suspense>
  );
}
