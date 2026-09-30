import type { Metadata } from "next";
import { Suspense } from "react";

import { AccountTicketView } from "@/components/account/SupportTicketsView";
import { Skeleton } from "@/components/ui/Skeleton";

export const metadata: Metadata = {
  title: "Support request",
  description: "A support request and its conversation.",
  // Personal pages: useful to the customer, never to a search engine.
  robots: { index: false, follow: false },
};

/**
 * One request, addressed as `/account/ticket?number=DCZ-2026-000123` — a
 * query parameter, like the order page, because request numbers only exist
 * at runtime.
 */
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="page-shell py-10">
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <AccountTicketView />
    </Suspense>
  );
}
