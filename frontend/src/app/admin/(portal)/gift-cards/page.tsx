import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminGiftCardsView } from "@/components/admin/views/engagement/AdminGiftCardsView";

export const metadata: Metadata = { title: "Gift cards" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminGiftCardsView />
    </Suspense>
  );
}
