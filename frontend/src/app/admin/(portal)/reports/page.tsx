import type { Metadata } from "next";

import { AdminReportsView } from "@/components/admin/views/AdminReportsView";

export const metadata: Metadata = { title: "Reports" };

export default function Page() {
  return <AdminReportsView />;
}
