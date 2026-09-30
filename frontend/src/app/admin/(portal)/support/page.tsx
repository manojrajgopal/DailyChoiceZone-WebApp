import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSupportDeskView } from "@/components/admin/views/support/AdminSupportDeskView";

export const metadata: Metadata = { title: "Support desk" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSupportDeskView />
    </Suspense>
  );
}
