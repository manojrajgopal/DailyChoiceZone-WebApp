import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminSearchView } from "@/components/admin/views/search/AdminSearchView";

export const metadata: Metadata = { title: "Search" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminSearchView />
    </Suspense>
  );
}
