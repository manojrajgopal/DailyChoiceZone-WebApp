import type { Metadata } from "next";

import { AdminCreditNotesView } from "@/components/admin/views/AdminCreditNotesView";

export const metadata: Metadata = { title: "Credit notes" };

export default function Page() {
  return <AdminCreditNotesView />;
}
