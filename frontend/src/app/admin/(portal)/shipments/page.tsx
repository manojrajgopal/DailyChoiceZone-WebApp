import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminShipmentsView } from "@/components/admin/views/shipping/AdminShipmentsView";

export const metadata: Metadata = { title: "Shipments" };

export default function Page() {
  // Filters are read from the address, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <AdminShipmentsView />
    </Suspense>
  );
}
