import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminQuestionsView } from "@/components/admin/views/engagement/AdminQuestionsView";

export const metadata: Metadata = { title: "Product questions" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminQuestionsView />
    </Suspense>
  );
}
