import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminStoreCreditView } from "@/components/admin/views/engagement/AdminStoreCreditView";

export const metadata: Metadata = { title: "Store credit" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminStoreCreditView />
    </Suspense>
  );
}
