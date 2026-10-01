"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Info, X } from "lucide-react";

import { useSession } from "@/hooks/useSession";
import { ApiError } from "@/services/api/client";
import { openRecoveryLink, type RecoveryChange } from "@/services/cartService";

/**
 * What a shopper sees arriving from a bag-reminder email (`/cart?recover=…`).
 *
 * The link signs nobody in: a signed-out visitor is asked to sign in and
 * brought back. Signed in, the server checks the link belongs to them and
 * says what changed since the email — a new price, something sold out — and
 * puts the items back if the bag has been emptied meanwhile.
 */
export function CartRecoveryNotice({ onRestored }: { onRestored: () => void }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const token = params?.get("recover") ?? "";
  const { isSignedIn, isLoading } = useSession();
  const [result, setResult] = useState<{ changes: RecoveryChange[]; restored: number } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const opened = useRef(false);

  useEffect(() => {
    if (!token || isLoading || !isSignedIn || opened.current) return;
    opened.current = true;
    openRecoveryLink(token)
      .then((data) => {
        setResult(data);
        if (data.restored > 0) onRestored();
      })
      .catch((error) =>
        setProblem(
          error instanceof ApiError && error.status === 404
            ? "This bag reminder belongs to a different account. Your own bag is shown below."
            : "We couldn't open your saved bag just now. Your bag is shown below.",
        ),
      )
      .finally(() => {
        // The token has done its job; keep it out of the address bar and history.
        router.replace(pathname, { scroll: false });
      });
  }, [token, isLoading, isSignedIn, onRestored, pathname, router]);

  if (dismissed) return null;

  if (token && !isLoading && !isSignedIn) {
    return (
      <Box>
        <span className="font-medium text-ink">Welcome back.</span> Sign in to see the bag you saved.{" "}
        <Link href={`/account?next=${encodeURIComponent(`/cart?recover=${token}`)}`} className="text-ink underline underline-offset-4">
          Sign in
        </Link>
      </Box>
    );
  }

  if (problem) {
    return <Box onDismiss={() => setDismissed(true)}>{problem}</Box>;
  }

  if (!result) return null;
  const { changes, restored } = result;

  return (
    <Box onDismiss={() => setDismissed(true)}>
      <p>
        <span className="font-medium text-ink">Welcome back.</span>{" "}
        {restored > 0
          ? `We've put ${restored === 1 ? "your item" : `${restored} items`} back in your bag.`
          : "Your bag is just as you left it."}
        {changes.length ? " A few things have changed since:" : ""}
      </p>
      {changes.length ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {changes.map((change, index) => (
            <li key={`${change.name}-${index}`}>{change.message}</li>
          ))}
        </ul>
      ) : null}
    </Box>
  );
}

function Box({ children, onDismiss }: { children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <div role="status" className="mt-6 flex items-start gap-3 rounded-card border border-copper-200 bg-copper-50 p-4 text-sm leading-relaxed text-ink-700">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-copper-700" strokeWidth={1.5} aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss ? (
        <button type="button" onClick={onDismiss} className="shrink-0 text-ink-400 hover:text-ink" aria-label="Dismiss">
          <X className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
