import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminNotificationsView } from "@/components/admin/views/messaging/AdminNotificationsView";

export const metadata: Metadata = { title: "Notifications" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminNotificationsView />
    </Suspense>
  );
}
