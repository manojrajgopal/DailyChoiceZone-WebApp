import type { Metadata } from "next";

import { AdminLoginView } from "@/components/admin/views/AdminLoginView";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function AdminLoginPage() {
  return <AdminLoginView />;
}
