import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminWebhooksView } from "@/components/admin/views/operations/AdminWebhooksView";

export const metadata: Metadata = { title: "Payment webhooks" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminWebhooksView />
    </Suspense>
  );
}
