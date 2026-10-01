import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminHealthView } from "@/components/admin/views/growth/AdminHealthView";

export const metadata: Metadata = { title: "System health" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminHealthView />
    </Suspense>
  );
}
