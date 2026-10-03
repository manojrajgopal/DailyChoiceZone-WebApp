import type { Metadata } from "next";
import { Suspense } from "react";

import { AuthCompleteView } from "@/components/account/AuthCompleteView";

export const metadata: Metadata = {
  title: "Signing you in",
  robots: { index: false, follow: false },
  // The one-time code is in this page's address: never send it on as a referrer.
  referrer: "no-referrer",
};

/** The end of a Google / Apple / Microsoft sign-in. Reads the query string, so it renders in the browser. */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <AuthCompleteView />
    </Suspense>
  );
}
