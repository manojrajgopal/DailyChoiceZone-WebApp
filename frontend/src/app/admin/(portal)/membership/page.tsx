import type { Metadata } from "next";

import { AdminMembershipView } from "@/components/admin/views/AdminMembershipView";

export const metadata: Metadata = { title: "Membership" };

export default function Page() {
  return <AdminMembershipView />;
}
