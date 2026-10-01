import type { Metadata } from "next";
import { Suspense } from "react";

import { VerifyEmailView } from "@/components/account/AccountRecovery";

export const metadata: Metadata = {
  title: "Confirm your email",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailView />
    </Suspense>
  );
}
