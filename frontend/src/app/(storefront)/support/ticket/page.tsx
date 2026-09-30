import type { Metadata } from "next";
import { Suspense } from "react";

import { GuestTicketView } from "@/components/support/GuestTicketView";
import { Skeleton } from "@/components/ui/Skeleton";

export const metadata: Metadata = {
  title: "Your support request",
  description: "Follow and reply to your request to Daily Choice Zone.",
  // Reached from an emailed link that carries a private key.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="page-shell py-10">
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <GuestTicketView />
    </Suspense>
  );
}
