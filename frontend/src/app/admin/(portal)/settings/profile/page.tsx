import type { Metadata } from "next";

import { AdminProfileView } from "@/components/admin/views/AdminProfileView";

export const metadata: Metadata = { title: "My profile" };

export default function Page() {
  return <AdminProfileView />;
}
