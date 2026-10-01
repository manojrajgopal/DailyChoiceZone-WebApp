import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminBackupsView } from "@/components/admin/views/messaging/AdminBackupsView";

export const metadata: Metadata = { title: "Backups" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminBackupsView />
    </Suspense>
  );
}
