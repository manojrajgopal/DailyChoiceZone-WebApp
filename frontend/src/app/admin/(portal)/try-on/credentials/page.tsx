import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminTryOnCredentialsView } from "@/components/admin/views/tryon/AdminTryOnCredentialsView";

export const metadata: Metadata = { title: "Try-on credentials" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminTryOnCredentialsView />
    </Suspense>
  );
}
