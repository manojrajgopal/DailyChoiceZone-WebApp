import type { Metadata } from "next";

import { Suspense } from "react";

import { AdminRefundsQueueView } from "@/components/admin/views/refunds/AdminRefundsQueueView";

export const metadata: Metadata = { title: "Refunds" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminRefundsQueueView />
    </Suspense>
  );
}
