import type { Metadata } from "next";

import { AdminSizeGuidesView } from "@/components/admin/views/discovery/AdminSizeGuidesView";

export const metadata: Metadata = { title: "Size guides" };

export default function Page() {
  return <AdminSizeGuidesView />;
}
