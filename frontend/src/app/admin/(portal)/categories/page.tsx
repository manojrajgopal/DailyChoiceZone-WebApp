import type { Metadata } from "next";

import { AdminCategoriesView } from "@/components/admin/views/AdminCategoriesView";

export const metadata: Metadata = { title: "Categories" };

export default function Page() {
  return <AdminCategoriesView />;
}
