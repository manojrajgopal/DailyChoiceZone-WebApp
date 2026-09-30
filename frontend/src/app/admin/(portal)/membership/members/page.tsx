import type { Metadata } from "next";
import { Suspense } from "react";

import { AdminMembersDirectoryView } from "@/components/admin/views/AdminMembersDirectoryView";

export const metadata: Metadata = { title: "Member directory" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AdminMembersDirectoryView />
    </Suspense>
  );
}
