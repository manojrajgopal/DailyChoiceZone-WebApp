"use client";

import { useEffect, useRef, useState } from "react";

import type { AuthSession } from "@/types";
import type { IssuedOtp, OtpChannel } from "@/types/identity";

import { Button } from "@/components/ui/Button";
import { Checkbox, Input } from "@/components/ui/Field";
import {
  codeOf,
  messageOf,
  requestSignInCode,
  signUpWithCode,
  verifySignInCode,
} from "@/services/identityService";

import { CodeStep } from "./CodeStep";

export interface OtpSignInProps {
  /** Which channels the store has switched on. At least one should be. */
  emailOtp: boolean;
  mobileOtp: boolean;
  /** "signup" on the Create account tab. The same code signs in or creates an account. */
  purpose?: "login" | "signup";
  /** A friend's referral code, passed on if the code ends up creating an account. */
  referralCode?: string;
  /** Signed in (or signed up); the token is already stored. */
  onSignedIn: (session: AuthSession, created: boolean) => void;
  /** Told when the store has switched code sign-in off since the page loaded. */
  onUnavailable?: () => void;
}

type Step =
  | { kind: "destination" }
  | { kind: "code"; issued: IssuedOtp; destination: string }
  | { kind: "signup"; signupToken: string; channel: OtpChannel; destination: string };

/**
 * Sign in — or create an account — with a one-time code by SMS or email.
 *
 * Three steps: where to send the code, the code, and (only when nobody has
 * an account at that number or address yet) a name to create one with. The
 * server never says whether an account exists until the code has proved the
 * number or address is the shopper's.
 */
export function OtpSignIn({ emailOtp, mobileOtp, purpose = "login", referralCode, onSignedIn, onUnavailable }: OtpSignInProps) {
  const [channel, setChannel] = useState<OtpChannel>(mobileOtp ? "sms" : "email");
  const [destination, setDestination] = useState("");
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "destination" });

  const both = emailOtp && mobileOtp;
  const activeChannel: OtpChannel = channel === "sms" && !mobileOtp ? "email" : channel === "email" && !emailOtp ? "sms" : channel;

  const request = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = destination.trim();
    if (!value) return;
    setBusy(true);
    setError(undefined);
    setFieldError(undefined);
    try {
      const issued = await requestSignInCode(activeChannel, value, purpose);
      setStep({ kind: "code", issued, destination: value });
    } catch (failure) {
      const code = codeOf(failure);
      if (code === "PHONE_INVALID" || code === "EMAIL_INVALID") setFieldError(messageOf(failure));
      else {
        setError(messageOf(failure, "We couldn't send the code just now. Please try again."));
        if (code === "AUTH_METHOD_DISABLED") onUnavailable?.();
      }
    } finally {
      setBusy(false);
    }
  };

  if (step.kind === "code") {
    return (
      <CodeStep
        key={step.issued.challengeId}
        issued={step.issued}
        submitLabel="Continue"
        onVerify={async (challengeId, code) => {
          const result = await verifySignInCode(challengeId, code);
          if (result.status === "signed-in") onSignedIn(result.session, false);
          else setStep({ kind: "signup", signupToken: result.signupToken, channel: result.channel, destination: result.destination });
        }}
        onResend={() => requestSignInCode(step.issued.channel, step.destination, purpose)}
        onBack={() => setStep({ kind: "destination" })}
        backLabel={step.issued.channel === "sms" ? "Use a different number" : "Use a different email"}
        hint={step.issued.channel === "email" ? "Can't see it? Check your spam or promotions folder." : undefined}
      />
    );
  }

  if (step.kind === "signup") {
    return (
      <CodeSignUp
        step={step}
        referralCode={referralCode}
        onSignedIn={(session) => onSignedIn(session, true)}
        onExpired={(message) => {
          setStep({ kind: "destination" });
          setError(message);
        }}
      />
    );
  }

  return (
    <form onSubmit={request} className="flex flex-col gap-5">
      {both ? (
        <div role="radiogroup" aria-label="Send the code by" className="flex gap-2">
          {(
            [
              ["sms", "Mobile number"],
              ["email", "Email"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={activeChannel === value}
              onClick={() => {
                setChannel(value);
                setDestination("");
                setFieldError(undefined);
                setError(undefined);
              }}
              className={
                activeChannel === value
                  ? "rounded-pill border border-ink bg-ink px-4 py-2 text-sm text-cream"
                  : "rounded-pill border border-ink-200 px-4 py-2 text-sm text-ink-700 transition-colors hover:border-ink-400"
              }
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {activeChannel === "sms" ? (
        <Input
          key="sms"
          label="Mobile number"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={destination}
          onChange={(event) => {
            setDestination(event.target.value);
            setFieldError(undefined);
          }}
          placeholder="98765 43210"
          hint="We'll text you a code. Standard message rates may apply."
          error={fieldError}
          required
        />
      ) : (
        <Input
          key="email"
          label="Email address"
          type="email"
          autoComplete="email"
          value={destination}
          onChange={(event) => {
            setDestination(event.target.value);
            setFieldError(undefined);
          }}
          placeholder="you@example.com"
          hint="We'll email you a code."
          error={fieldError}
          required
        />
      )}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="submit" size="lg" fullWidth disabled={busy || !destination.trim()}>
        {busy ? "Sending…" : "Send code"}
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------- sign up */

function CodeSignUp({
  step,
  referralCode,
  onSignedIn,
  onExpired,
}: {
  step: Extract<Step, { kind: "signup" }>;
  referralCode?: string;
  onSignedIn: (session: AuthSession) => void;
  onExpired: (message: string) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [offers, setOffers] = useState(true);
  const [emailError, setEmailError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  const needsEmail = step.channel === "sms";

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setEmailError(undefined);
    try {
      const session = await signUpWithCode({
        signupToken: step.signupToken,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: needsEmail ? email.trim() : undefined,
        referralCode: referralCode?.trim() || undefined,
        marketingOptIn: offers,
      });
      onSignedIn(session);
    } catch (failure) {
      const code = codeOf(failure);
      if (code === "SIGNUP_EXPIRED") onExpired(messageOf(failure));
      else if (code === "EMAIL_TAKEN" || code === "EMAIL_REQUIRED" || code === "EMAIL_INVALID") setEmailError(messageOf(failure));
      else setError(messageOf(failure, "We couldn't create your account just now. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <p role="status" className="text-sm leading-relaxed text-ink-700">
        <span className="font-medium text-ink">{step.destination}</span> is confirmed. Tell us your name to
        finish creating your account.
      </p>
      <div className="grid gap-5 sm:grid-cols-2">
        <Input
          ref={firstRef}
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
      {needsEmail ? (
        <Input
          label="Email address"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setEmailError(undefined);
          }}
          placeholder="you@example.com"
          hint="For your order confirmations and receipts."
          error={emailError}
          required
        />
      ) : emailError ? (
        <p role="alert" className="text-sm text-danger">
          {emailError}
        </p>
      ) : null}
      <Checkbox
        label="Email me about offers and new arrivals (you can stop any time)"
        checked={offers}
        onChange={(event) => setOffers(event.target.checked)}
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" fullWidth disabled={busy || !firstName.trim() || (needsEmail && !email.trim())}>
        {busy ? "Please wait…" : "Create account"}
      </Button>
    </form>
  );
}
