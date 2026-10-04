import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminLookupView } from "@/components/admin/views/AdminLookupView";

export const metadata: Metadata = { title: "ID lookup" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminLookupView />
    </Suspense>
  );
}
