import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminTryOnPlansView } from "@/components/admin/views/tryon/AdminTryOnPlansView";

export const metadata: Metadata = { title: "Try-on plan entitlements" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminTryOnPlansView />
    </Suspense>
  );
}
