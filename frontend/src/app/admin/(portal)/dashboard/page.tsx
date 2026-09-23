import type { Metadata } from "next";

import { AdminDashboardView } from "@/components/admin/views/AdminDashboardView";

export const metadata: Metadata = { title: "Dashboard" };

export default function AdminDashboardPage() {
  return <AdminDashboardView />;
}
