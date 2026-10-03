"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";

import { oauthErrorMessage, providerLabel } from "@/components/account/auth/messages";
import { ButtonLink } from "@/components/ui/Button";
import { useSession } from "@/hooks/useSession";
import { safeRedirect } from "@/lib/utils/safeRedirect";
import { completeOAuth, messageOf } from "@/services/identityService";
import { toast } from "@/store/toastStore";

/**
 * Where a Google / Apple / Microsoft trip ends (`/auth/complete`).
 *
 * The API sends the browser here with one of:
 *
 * - `?code=` — a one-time code, exchanged for a session (once: React's
 *   development double-run must not spend it twice), then on to `next`;
 * - `?linked=<provider>` — an account was connected from Settings;
 * - `?error=<code>` — it didn't work, said in words rather than as the code.
 *
 * `next` is only followed when it is a path on this site; anything else
 * lands on the account page.
 */
export function AuthCompleteView() {
  const params = useSearchParams();
  const router = useRouter();
  const { acceptSession } = useSession();

  const code = params?.get("code") ?? "";
  const linked = params?.get("linked") ?? "";
  const errorCode = params?.get("error") ?? "";
  const isLink = params?.get("mode") === "link";
  const next = params?.get("next");

  const [failure, setFailure] = useState<string | null>(
    errorCode ? oauthErrorMessage(errorCode) : !code && !linked ? "This sign-in link is incomplete." : null,
  );
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || errorCode) return;

    if (code) {
      handled.current = true;
      completeOAuth(code)
        .then(({ session, created }) => {
          acceptSession(
            session,
            created
              ? `Welcome to Daily Choice Zone, ${session.user.firstName}`
              : `Welcome back, ${session.user.firstName}`,
          );
          router.replace(safeRedirect(next, "/account"));
        })
        .catch((error: unknown) => {
          setFailure(messageOf(error, "We couldn't finish signing you in. Please try again."));
        });
      return;
    }

    if (linked) {
      handled.current = true;
      toast.success(`${providerLabel(linked)} is now connected to your account`);
      router.replace(safeRedirect(next, "/account/settings"));
    }
  }, [code, linked, errorCode, next, acceptSession, router]);

  if (!failure) {
    return (
      <div className="page-shell py-16">
        <p className="mx-auto max-w-md text-center text-sm text-ink-500" role="status" aria-live="polite">
          {linked ? "Connecting your account…" : "Signing you in…"}
        </p>
      </div>
    );
  }

  const back = isLink || linked ? { href: "/account/settings", label: "Back to Settings" } : { href: "/account", label: "Back to sign in" };

  return (
    <div className="page-shell py-10 sm:py-14">
      <div className="mx-auto max-w-md">
        <h1 className="font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">
          {isLink ? "We couldn't connect that account" : "We couldn't sign you in"}
        </h1>
        <div role="alert" className="mt-8 flex gap-3 rounded-card border border-[#f1c4c4] bg-[#fdf4f4] p-4">
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-ink-700" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-sm leading-relaxed text-ink-700">{failure}</p>
        </div>
        <ButtonLink href={back.href} className="mt-6">
          {back.label}
        </ButtonLink>
      </div>
    </div>
  );
}
