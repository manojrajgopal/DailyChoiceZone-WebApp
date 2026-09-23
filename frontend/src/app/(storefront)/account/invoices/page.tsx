import type { Metadata } from "next";

import { AccountShell } from "@/components/account/AccountShell";
import { InvoicesView } from "@/components/account/InvoicesView";

export const metadata: Metadata = {
  title: "Your invoices",
  description: "View, print and download invoices for your Daily Choice Zone orders.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <AccountShell
      title="Invoices"
      description="An invoice is raised for every order. Open one to print or download it."
      breadcrumb={[{ label: "Invoices" }]}
    >
      <InvoicesView />
    </AccountShell>
  );
}
