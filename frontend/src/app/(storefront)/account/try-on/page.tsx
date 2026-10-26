import type { Metadata } from "next";
import { Suspense } from "react";

import { AccountTryOnView } from "@/components/account/AccountTryOnView";

export const metadata: Metadata = {
  title: "Virtual try-on",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <AccountTryOnView />
    </Suspense>
  );
}
