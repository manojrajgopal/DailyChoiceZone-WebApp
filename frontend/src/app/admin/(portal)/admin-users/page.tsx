import type { Metadata } from "next";

import { AdminUsersView } from "@/components/admin/views/AdminUsersView";

export const metadata: Metadata = { title: "Admin users" };

export default function Page() {
  return <AdminUsersView />;
}
