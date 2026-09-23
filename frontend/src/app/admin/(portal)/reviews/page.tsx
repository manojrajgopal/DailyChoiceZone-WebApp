import type { Metadata } from "next";

import { AdminReviewsView } from "@/components/admin/views/AdminReviewsView";

export const metadata: Metadata = { title: "Reviews" };

export default function Page() {
  return <AdminReviewsView />;
}
