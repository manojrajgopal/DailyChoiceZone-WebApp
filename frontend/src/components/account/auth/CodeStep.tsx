"use client";

import { useEffect, useRef, useState } from "react";

import type { IssuedOtp } from "@/types/identity";

import { Button } from "@/components/ui/Button";

import { describeCodeError, retryAfterOf } from "./messages";
import { OtpCodeInput } from "./OtpCodeInput";
import { formatSeconds, useCountdown } from "./useCountdown";

export interface CodeStepProps {
  /** The code the API has just sent. Key the step on its `challengeId` to start over with a new one. */
  issued: IssuedOtp;
  /** Check the code; throw the API's error when it is wrong. */
  onVerify: (challengeId: string, code: string) => Promise<void>;
  /** Ask for another code; throw the API's error when one can't be sent. */
  onResend: () => Promise<IssuedOtp>;
  submitLabel?: string;
  /** Check the code as soon as the last digit is in. Off when the form has other fields to fill. */
  autoSubmit?: boolean;
  /** Other fields that go with the code (a new password). */
  children?: React.ReactNode;
  /** Whether those other fields are ready. */
  canSubmit?: boolean;
  onBack?: () => void;
  backLabel?: string;
  /** Shown under the input, e.g. "Check your spam folder too". */
  hint?: string;
}

const SENT_TO = { sms: "texted", email: "emailed" } as const;

/**
 * "Enter the code we sent to …" — one step, used everywhere a code is typed.
 *
 * It knows the code's timings: the countdown to "Send a new code" (from
 * `resendIn`, or the API's `retryAfter` when it said to wait) and the moment
 * the code expires, after which only a new code will do. A wrong code says
 * how many tries are left; a spent one (locked, used, replaced) asks for a
 * new one. The code is held in this component's state only, and only until
 * it is sent.
 */
export function CodeStep({
  issued: initial,
  onVerify,
  onResend,
  submitLabel = "Continue",
  autoSubmit = true,
  children,
  canSubmit = true,
  onBack,
  backLabel = "Back",
  hint,
}: CodeStepProps) {
  const [issued, setIssued] = useState(initial);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [dead, setDead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState("");
  const [resendIn, restartResend] = useCountdown(initial.resendIn);
  const [expiresIn, restartExpiry] = useCountdown(initial.expiresIn);
  const inputRef = useRef<HTMLInputElement>(null);

  // Straight to the box: the shopper's next move is typing the code.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const expired = issued.expiresIn > 0 && expiresIn === 0;
  const spent = dead || expired;
  const shownError = error ?? (expired ? "This code has expired. Ask for a new one." : undefined);

  const verify = async (value: string) => {
    if (busy || spent || value.length !== issued.length || !canSubmit) return;
    setBusy(true);
    setError(undefined);
    setNotice("");
    try {
      await onVerify(issued.challengeId, value);
    } catch (failure) {
      const { message, dead: isDead } = describeCodeError(failure);
      setError(message);
      setDead(isDead);
      if (!isDead) {
        // Let them correct it without clearing what they typed.
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setResending(true);
    setError(undefined);
    setNotice("");
    try {
      const next = await onResend();
      setIssued(next);
      setCode("");
      setDead(false);
      restartResend(next.resendIn);
      restartExpiry(next.expiresIn);
      setNotice(`We've sent a new code to ${next.destination}.`);
      inputRef.current?.focus();
    } catch (failure) {
      const wait = retryAfterOf(failure);
      if (wait !== null) restartResend(wait);
      setError(failure instanceof Error && failure.message ? failure.message : "We couldn't send a new code just now.");
    } finally {
      setResending(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void verify(code);
      }}
      className="flex flex-col gap-5"
    >
      <p className="text-sm leading-relaxed text-ink-700">
        We&rsquo;ve {SENT_TO[issued.channel] ?? "sent"} a {issued.length}-digit code to{" "}
        <span className="font-medium text-ink">{issued.destination}</span>.
        {issued.expiresIn > 0 && !expired ? ` It works for ${Math.max(1, Math.round(issued.expiresIn / 60))} minutes.` : ""}
      </p>

      <OtpCodeInput
        ref={inputRef}
        length={issued.length}
        value={code}
        onChange={(value) => {
          setCode(value);
          if (!spent) setError(undefined);
        }}
        onComplete={autoSubmit ? (value) => void verify(value) : undefined}
        error={shownError}
        hint={hint}
        disabled={busy}
      />

      {children}

      {/* What just happened, said once to a screen reader. */}
      <p role="status" aria-live="polite" className={notice ? "text-xs text-ink-500" : "sr-only"}>
        {notice}
      </p>

      <Button
        type="submit"
        size="lg"
        fullWidth
        disabled={busy || spent || code.length !== issued.length || !canSubmit}
      >
        {busy ? "Checking…" : submitLabel}
      </Button>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        {resendIn > 0 ? (
          <p className="text-ink-500">
            {/* The ticking number is for the eye; the live region below says when it's done. */}
            <span aria-hidden="true">You can ask for a new code in {formatSeconds(resendIn)}</span>
            <span className="sr-only">You can ask for a new code in {resendIn} seconds</span>
          </p>
        ) : (
          <button
            type="button"
            onClick={() => void resend()}
            disabled={resending}
            className="text-ink underline underline-offset-4 transition-colors hover:text-copper-700 disabled:text-ink-300"
          >
            {resending ? "Sending…" : "Send a new code"}
          </button>
        )}
        <span className="sr-only" aria-live="polite">
          {resendIn === 0 ? "You can ask for a new code now." : ""}
        </span>

        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="text-ink-500 underline underline-offset-4 transition-colors hover:text-ink"
          >
            {backLabel}
          </button>
        ) : null}
      </div>
    </form>
  );
}
