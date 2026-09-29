import type { Metadata } from "next";

import { AdminReturnsView } from "@/components/admin/views/AdminReturnsView";

export const metadata: Metadata = { title: "Returns & replacements" };

export default function Page() {
  return <AdminReturnsView />;
}
