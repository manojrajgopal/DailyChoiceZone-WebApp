import type { Metadata } from "next";

import { AdminBannersView } from "@/components/admin/views/AdminBannersView";

export const metadata: Metadata = { title: "Banners" };

export default function Page() {
  return <AdminBannersView />;
}
