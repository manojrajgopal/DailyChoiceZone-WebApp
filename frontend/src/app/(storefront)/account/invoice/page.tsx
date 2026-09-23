import type { Metadata } from "next";

import { InvoiceDetailView } from "@/components/account/InvoiceDetailView";

export const metadata: Metadata = {
  title: "Invoice",
  description: "Your Daily Choice Zone invoice.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <InvoiceDetailView />;
}
