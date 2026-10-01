import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminAuditLogView } from "@/components/admin/views/growth/AdminAuditLogView";

export const metadata: Metadata = { title: "Audit log" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminAuditLogView />
    </Suspense>
  );
}
