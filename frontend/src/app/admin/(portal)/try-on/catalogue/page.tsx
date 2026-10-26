import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminTryOnCatalogueView } from "@/components/admin/views/tryon/AdminTryOnCatalogueView";

export const metadata: Metadata = { title: "Try-on models & categories" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminTryOnCatalogueView />
    </Suspense>
  );
}
