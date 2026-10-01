import type { Metadata } from "next";
import { Suspense } from "react";

import { ForgotPasswordView } from "@/components/account/AccountRecovery";

export const metadata: Metadata = {
  title: "Forgot your password?",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordView />
    </Suspense>
  );
}
