"use client";

import { useEffect } from "react";

import { ErrorState } from "@/components/common/States";
import { ButtonLink } from "@/components/ui/Button";

/**
 * The route-level error boundary.
 *
 * `reset` re-renders the segment, which is the right first thing to try for a
 * transient failure. The error digest is logged rather than shown, because a
 * stack trace tells a shopper nothing useful.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // A real deployment would forward this to an error tracker.
    console.error("Storefront error:", error);
  }, [error]);

  return (
    <div className="page-shell py-16">
      <ErrorState
        title="Something went wrong"
        description="We hit an unexpected problem loading this page. Trying again usually sorts it."
        onRetry={reset}
      />

      <div className="flex justify-center">
        <ButtonLink href="/" variant="ghost" className="border border-ink-200">
          Back to home
        </ButtonLink>
      </div>
    </div>
  );
}
