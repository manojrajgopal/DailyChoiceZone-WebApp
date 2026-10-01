"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, MailCheck, TriangleAlert } from "lucide-react";

import { Button, ButtonLink } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useSession } from "@/hooks/useSession";
import {
  checkResetToken,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  verifyEmail,
} from "@/services/authService";
import { useSessionStore } from "@/store/sessionStore";
import { toast } from "@/store/toastStore";

/**
 * Forgotten passwords and email confirmation.
 *
 * The token in each link is read from the address bar and sent to the API as
 * it is; the browser never decides whether a link is good — the server does,
 * and the page shows what it said.
 */

const PASSWORD_HINT = "At least eight characters, with a letter and a number.";

/** "This link has expired" and friends: codes that mean "ask for a new one". */
const DEAD_LINK = new Set(["TOKEN_INVALID", "TOKEN_USED", "TOKEN_EXPIRED", "TOKEN_SUPERSEDED"]);

function Frame({ title, intro, children }: { title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="page-shell py-10 sm:py-14">
      <div className="mx-auto max-w-md">
        <h1 className="font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">{title}</h1>
        {intro ? <p className="mt-2.5 text-sm leading-relaxed text-ink-500">{intro}</p> : null}
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}

function Notice({ tone, title, children }: { tone: "good" | "bad" | "info"; title: string; children?: React.ReactNode }) {
  const Icon = tone === "good" ? CheckCircle2 : tone === "bad" ? TriangleAlert : MailCheck;
  const colours =
    tone === "good"
      ? "border-[#bfe3bf] bg-[#f1f9f1]"
      : tone === "bad"
        ? "border-[#f1c4c4] bg-[#fdf4f4]"
        : "border-copper-200 bg-copper-50";
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={`flex gap-3 rounded-card border p-4 ${colours}`}>
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-ink-700" strokeWidth={1.5} aria-hidden="true" />
      <div className="text-sm leading-relaxed text-ink-700">
        <p className="font-medium text-ink">{title}</p>
        {children ? <div className="mt-1">{children}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ forgot */

export function ForgotPasswordView() {
  const params = useSearchParams();
  const [email, setEmail] = useState(params?.get("email") ?? "");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await requestPasswordReset(email.trim());
    setBusy(false);
    if (result.ok) setSent(result.message);
    else setError(result.reason);
  };

  return (
    <Frame
      title="Forgot your password?"
      intro="Enter the email address you shop with and we'll send you a link to choose a new password."
    >
      {sent ? (
        <div className="flex flex-col gap-6">
          <Notice tone="info" title="Check your inbox">
            {sent} The link works once and expires soon. If it doesn&rsquo;t arrive in a few minutes, check your spam
            folder.
          </Notice>
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/account" variant="outline">
              Back to sign in
            </ButtonLink>
            <Button variant="ghost" onClick={() => setSent(null)}>
              Use a different email
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5" noValidate={false}>
          {error ? <Notice tone="bad" title={error} /> : null}
          <Input
            label="Email address"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
          />
          <Button type="submit" size="lg" fullWidth disabled={busy || !email.trim()}>
            {busy ? "Sending…" : "Send reset link"}
          </Button>
          <p className="text-center text-sm text-ink-500">
            Remembered it?{" "}
            <Link href="/account" className="text-ink underline underline-offset-4 hover:text-copper-700">
              Sign in
            </Link>
          </p>
        </form>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------- reset */

export function ResetPasswordView() {
  const params = useSearchParams();
  const token = params?.get("token") ?? "";
  const [state, setState] = useState<"checking" | "ready" | "dead" | "done">(token ? "checking" : "dead");
  const [problem, setProblem] = useState<string>(token ? "" : "This link is incomplete. Request a new one.");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void checkResetToken(token).then((result) => {
      if (!live) return;
      if (result.ok) setState("ready");
      else {
        setProblem(result.reason);
        setState("dead");
      }
    });
    return () => {
      live = false;
    };
  }, [token]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFieldError(null);
    if (password !== confirm) {
      setFieldError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    const result = await resetPassword(token, password, confirm);
    setBusy(false);
    if (result.ok) {
      setState("done");
      return;
    }
    if (result.code && DEAD_LINK.has(result.code)) {
      setProblem(result.reason);
      setState("dead");
    } else {
      setFieldError(result.reason);
    }
  };

  return (
    <Frame title="Choose a new password">
      {state === "checking" ? (
        <p className="text-sm text-ink-500" role="status">
          Checking your link…
        </p>
      ) : state === "dead" ? (
        <div className="flex flex-col gap-6">
          <Notice tone="bad" title="This link can't be used">
            {problem}
          </Notice>
          <ButtonLink href="/forgot-password">Send a new link</ButtonLink>
        </div>
      ) : state === "done" ? (
        <div className="flex flex-col gap-6">
          <Notice tone="good" title="Your password has been changed">
            Sign in with your new password. For your security, any other device that was signed in has been signed
            out.
          </Notice>
          <ButtonLink href="/account">Sign in</ButtonLink>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <Input
            label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint={PASSWORD_HINT}
            minLength={8}
            maxLength={72}
            required
          />
          <Input
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            error={fieldError ?? undefined}
            maxLength={72}
            required
          />
          <Button type="submit" size="lg" fullWidth disabled={busy || !password || !confirm}>
            {busy ? "Saving…" : "Change password"}
          </Button>
        </form>
      )}
    </Frame>
  );
}

/* ------------------------------------------------------------ verify */

export function VerifyEmailView() {
  const params = useSearchParams();
  const token = params?.get("token") ?? "";
  const { isSignedIn } = useSession();
  const updateUser = useSessionStore((state) => state.updateUser);
  const [state, setState] = useState<"checking" | "done" | "dead">(token ? "checking" : "dead");
  const [problem, setProblem] = useState(token ? "" : "This link is incomplete.");
  // A link is used once: React's development double-run must not spend it twice.
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    void verifyEmail(token).then((result) => {
      if (result.ok) {
        setState("done");
        updateUser({ emailVerified: true });
      } else {
        setProblem(result.reason);
        setState("dead");
      }
    });
  }, [token, updateUser]);

  return (
    <Frame title="Confirm your email">
      {state === "checking" ? (
        <p className="text-sm text-ink-500" role="status">
          Confirming your email address…
        </p>
      ) : state === "done" ? (
        <div className="flex flex-col gap-6">
          <Notice tone="good" title="Your email address is confirmed">
            Thank you — we&rsquo;ll use it for your orders and account security.
          </Notice>
          <ButtonLink href={isSignedIn ? "/account" : "/shop"}>{isSignedIn ? "Go to your account" : "Continue shopping"}</ButtonLink>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <Notice tone="bad" title="This link can't be used">
            {problem} {isSignedIn ? "Send yourself a new one below." : "Sign in to send yourself a new one."}
          </Notice>
          {isSignedIn ? <ResendButton /> : <ButtonLink href="/account">Sign in</ButtonLink>}
        </div>
      )}
    </Frame>
  );
}

function ResendButton({ variant = "primary" }: { variant?: "primary" | "outline" }) {
  const [busy, setBusy] = useState(false);
  const updateUser = useSessionStore((state) => state.updateUser);
  const resend = async () => {
    setBusy(true);
    const result = await resendVerification();
    setBusy(false);
    if (result.ok) {
      toast.success(result.message);
      if (result.alreadyVerified) updateUser({ emailVerified: true });
    } else {
      toast.error(result.reason);
    }
  };
  return (
    <Button variant={variant} size="sm" onClick={() => void resend()} disabled={busy}>
      {busy ? "Sending…" : "Send the link again"}
    </Button>
  );
}

/** Shown across the account area until the address is confirmed. */
export function VerifyEmailBanner({ email }: { email: string }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-copper-200 bg-copper-50 p-4">
      <p className="min-w-0 text-sm leading-relaxed text-ink-700">
        <span className="font-medium text-ink">Please confirm your email address.</span> We sent a link to{" "}
        <span className="break-all">{email}</span>.
      </p>
      <ResendButton variant="outline" />
    </div>
  );
}
