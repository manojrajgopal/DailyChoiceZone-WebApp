import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminAbandonedCartsView } from "@/components/admin/views/operations/AdminAbandonedCartsView";

export const metadata: Metadata = { title: "Abandoned carts" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminAbandonedCartsView />
    </Suspense>
  );
}
