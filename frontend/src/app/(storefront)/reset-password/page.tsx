import type { Metadata } from "next";
import { Suspense } from "react";

import { ResetPasswordView } from "@/components/account/AccountRecovery";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false, follow: false },
  // The link carries a one-time token; it must not travel to other sites.
  referrer: "no-referrer",
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordView />
    </Suspense>
  );
}
