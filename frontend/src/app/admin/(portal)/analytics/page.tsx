import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminAnalyticsView } from "@/components/admin/views/growth/AdminAnalyticsView";

export const metadata: Metadata = { title: "Analytics" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminAnalyticsView />
    </Suspense>
  );
}
