import type { Metadata } from "next";
import { Suspense } from "react";

import { UnsubscribeView } from "@/components/account/UnsubscribeView";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <UnsubscribeView />
    </Suspense>
  );
}
