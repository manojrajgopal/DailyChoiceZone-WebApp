import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminTicketDetailView } from "@/components/admin/views/support/AdminTicketDetailView";

export const metadata: Metadata = { title: "Support ticket" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminTicketDetailView />
    </Suspense>
  );
}
