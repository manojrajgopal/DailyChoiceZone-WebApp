import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminAttributesView } from "@/components/admin/views/search/AdminAttributesView";

export const metadata: Metadata = { title: "Attributes" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminAttributesView />
    </Suspense>
  );
}
