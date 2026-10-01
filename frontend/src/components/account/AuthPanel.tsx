"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useSession } from "@/hooks/useSession";
import { safeRedirect } from "@/lib/utils/safeRedirect";

/**
 * Sign in and register, on one panel.
 *
 * Both go to the API. The password is verified against a bcrypt hash on the
 * server and is never held in the browser — what comes back is a token.
 */
export function AuthPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signIn, register } = useSession();

  /**
   * Where they were going before being asked to sign in.
   *
   * Checkout sends people here with `?next=` set to the step they left.
   * Passed through `safeRedirect` so it can only ever be a path on this site
   * — a sign-in page that forwards to wherever its URL says is an open
   * redirect, and the one moment somebody trusts a page most is right after
   * they have just signed in to it.
   */
  const next = searchParams?.get("next");
  const returnTo = next ? safeRedirect(next, "/account") : null;
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      const result =
        mode === "signin"
          ? await signIn({ email, password })
          : await register({ firstName, lastName, email, password });

      // Back to the checkout step they came from, now that they can finish it.
      if (result.ok && returnTo) router.replace(returnTo);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      {returnTo?.startsWith("/checkout") ? (
        <p className="mb-6 rounded-card border border-copper-200 bg-copper-50 p-4 text-sm leading-relaxed text-ink-700">
          <span className="font-medium text-ink">Sign in to check out.</span> Your bag is
          saved — you will go straight back to where you were.
        </p>
      ) : null}

      <div className="mb-8 flex gap-6 border-b border-ink-200">
        {(
          [
            ["signin", "Sign in"],
            ["register", "Create account"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            aria-pressed={mode === value}
            className={
              mode === value
                ? "-mb-px border-b-2 border-ink pb-3 label-wide text-ink"
                : "-mb-px border-b-2 border-transparent pb-3 label-wide text-ink-400 transition-colors hover:text-ink-700"
            }
          >
            {label}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        {mode === "register" ? (
          <div className="grid gap-5 sm:grid-cols-2">
            <Input
              label="First name"
              autoComplete="given-name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
            />
            <Input
              label="Last name"
              autoComplete="family-name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
            />
          </div>
        ) : null}

        <Input
          label="Email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          required
        />

        <Input
          label="Password"
          type="password"
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          // The rule the server enforces, stated where somebody is typing —
          // a hint that undersells it is a rejection they did not expect.
          hint={
            mode === "register" ? "At least eight characters, with a letter and a number." : undefined
          }
          required
        />

        {mode === "signin" ? (
          <p className="-mt-2 text-right text-sm">
            <Link
              href={email ? `/forgot-password?email=${encodeURIComponent(email)}` : "/forgot-password"}
              className="text-ink-500 underline underline-offset-4 transition-colors hover:text-ink"
            >
              Forgot your password?
            </Link>
          </p>
        ) : null}

        <Button type="submit" size="lg" disabled={isSubmitting} fullWidth className="mt-2">
          {isSubmitting
            ? "Please wait…"
            : mode === "signin"
              ? "Sign in"
              : "Create account"}
        </Button>
      </form>

    </div>
  );
}
