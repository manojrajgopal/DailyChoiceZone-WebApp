import type { Metadata } from "next";

import { AdminHomepageView } from "@/components/admin/views/AdminHomepageView";

export const metadata: Metadata = { title: "Homepage" };

export default function Page() {
  return <AdminHomepageView />;
}
