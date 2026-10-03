import type { Metadata } from "next";

import { AdminAuthenticationView } from "@/components/admin/views/auth/AdminAuthenticationView";

export const metadata: Metadata = { title: "Authentication" };

export default function Page() {
  return <AdminAuthenticationView />;
}
