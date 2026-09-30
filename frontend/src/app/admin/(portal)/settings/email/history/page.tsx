import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminEmailHistoryView } from "@/components/admin/views/AdminEmailHistoryView";

export const metadata: Metadata = { title: "Email history" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminEmailHistoryView />
    </Suspense>
  );
}
