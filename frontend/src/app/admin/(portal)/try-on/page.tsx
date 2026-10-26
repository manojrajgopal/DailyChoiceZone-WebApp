import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminTryOnOverviewView } from "@/components/admin/views/tryon/AdminTryOnOverviewView";

export const metadata: Metadata = { title: "Virtual try-on" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminTryOnOverviewView />
    </Suspense>
  );
}
