import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminAlertsView } from "@/components/admin/views/engagement/AdminAlertsView";

export const metadata: Metadata = { title: "Stock & price alerts" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminAlertsView />
    </Suspense>
  );
}
