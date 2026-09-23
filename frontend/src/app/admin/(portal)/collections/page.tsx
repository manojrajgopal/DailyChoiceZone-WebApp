import type { Metadata } from "next";

import { AdminCollectionsView } from "@/components/admin/views/AdminCollectionsView";

export const metadata: Metadata = { title: "Collections" };

export default function Page() {
  return <AdminCollectionsView />;
}
