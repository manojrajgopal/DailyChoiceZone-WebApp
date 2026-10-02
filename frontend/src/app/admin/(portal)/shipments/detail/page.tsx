import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminShipmentDetailView } from "@/components/admin/views/shipping/AdminShipmentDetailView";

export const metadata: Metadata = { title: "Shipment details" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminShipmentDetailView />
    </Suspense>
  );
}
