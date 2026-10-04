"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import type { AuthSession } from "@/types";
import type { IssuedOtp, SignInMethods } from "@/types/identity";

import { OtpSignIn } from "@/components/account/auth/OtpSignIn";
import { RegisterVerification } from "@/components/account/auth/RegisterVerification";
import { SocialButtons } from "@/components/account/auth/SocialButtons";
import { Button } from "@/components/ui/Button";
import { Checkbox, Input } from "@/components/ui/Field";
import { useSession } from "@/hooks/useSession";
import { normaliseMobile } from "@/lib/utils/phone";
import { safeRedirect } from "@/lib/utils/safeRedirect";
import { forgetReferralCode, rememberReferralCode, rememberedReferralCode } from "@/services/growthService";
import { FALLBACK_METHODS, getSignInMethods } from "@/services/identityService";

interface PendingRegistration {
  session: AuthSession;
  verification?: IssuedOtp | null;
  phoneVerification?: IssuedOtp | null;
  phone: string;
}

/**
 * Sign in and register, on one panel.
 *
 * Both go to the API. The password is verified against a bcrypt hash on the
 * server and is never held in the browser — what comes back is a token.
 *
 * Which ways in are offered is the store's choice (`GET /auth/methods`):
 * email and password, a one-time code by SMS or email, and Google / Apple /
 * Microsoft. Until the API answers — or if it can't — the password form is
 * shown, as it always was.
 */
export function AuthPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { signIn, register, acceptSession } = useSession();

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
  // Arriving from a friend's referral link opens on "Create account" with their code.
  const referralParam = searchParams?.get("ref") ?? "";
  const [mode, setMode] = useState<"signin" | "register">(referralParam ? "register" : "signin");
  const [referralCode, setReferralCode] = useState(referralParam.toUpperCase());

  useEffect(() => {
    if (referralParam) rememberReferralCode(referralParam);
    else {
      const remembered = rememberedReferralCode();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read from storage once, after hydration
      if (remembered) setReferralCode(remembered);
    }
  }, [referralParam]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string>();
  const [offers, setOffers] = useState(true);

  const [methods, setMethods] = useState<SignInMethods>(FALLBACK_METHODS);
  // "code": the one-time-code flow instead of the password form.
  const [view, setView] = useState<"password" | "code">("password");
  const [pending, setPending] = useState<PendingRegistration | null>(null);

  useEffect(() => {
    let active = true;
    void getSignInMethods().then((offered) => {
      if (active) setMethods(offered);
    });
    return () => {
      active = false;
    };
  }, []);

  const codeAvailable = methods.emailOtp || methods.mobileOtp;
  // With the password switched off, the code is the way in.
  const showCode = codeAvailable && (view === "code" || !methods.emailPassword);
  const showPassword = methods.emailPassword && !showCode;
  // Where a Google / Apple / Microsoft trip lands afterwards: where they were going, or here.
  const socialNext = returnTo ?? safeRedirect(pathname, "/account");

  /** Back to the checkout step they came from, now that they can finish it. */
  const goOn = () => {
    if (returnTo) router.replace(returnTo);
  };

  const finishWith = (session: AuthSession, message?: string) => {
    acceptSession(session, message);
    goOn();
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    const mobile = mode === "register" && methods.mobileOtp && phone.trim() ? normaliseMobile(phone) : "";
    if (mobile === null) {
      setPhoneError("Enter a 10-digit mobile number, or leave it blank.");
      return;
    }

    setIsSubmitting(true);
    try {
      const result =
        mode === "signin"
          ? await signIn({ email, password })
          : await register({
              firstName,
              lastName,
              email,
              password,
              referralCode: referralCode.trim() || undefined,
              marketingOptIn: offers,
              ...(mobile ? { phone: mobile } : {}),
            });

      if (!result.ok) {
        // Switched off since the page loaded: stop offering the form.
        if (result.code === "AUTH_METHOD_DISABLED") setMethods((current) => ({ ...current, emailPassword: false }));
        return;
      }

      if (mode === "register") forgetReferralCode();

      // Codes to type before carrying on: the panel stays up to take them.
      if (result.verification || result.phoneVerification) {
        setPending({
          session: result.session,
          verification: result.verification,
          phoneVerification: result.phoneVerification,
          phone: mobile || "",
        });
        return;
      }

      goOn();
    } finally {
      setIsSubmitting(false);
    }
  };

  if (pending) {
    return (
      <div className="mx-auto max-w-md">
        <RegisterVerification
          session={pending.session}
          verification={pending.verification}
          phoneVerification={pending.phoneVerification}
          phone={pending.phone}
          onDone={(session) => finishWith(session)}
        />
      </div>
    );
  }

  const nothingOffered = !methods.emailPassword && !codeAvailable && methods.providers.length === 0;

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

      {nothingOffered ? (
        <p role="status" className="rounded-card border border-ink-200 bg-shell p-4 text-sm leading-relaxed text-ink-700">
          Signing in isn&rsquo;t available just now. Please try again in a little while.
        </p>
      ) : null}

      {showCode ? (
        <OtpSignIn
          key={mode}
          emailOtp={methods.emailOtp}
          mobileOtp={methods.mobileOtp}
          purpose={mode === "register" ? "signup" : "login"}
          referralCode={referralCode}
          onSignedIn={(session, created) => {
            if (created) forgetReferralCode();
            finishWith(session, created ? "Account created" : `Welcome back, ${session.user.firstName}`);
          }}
          onUnavailable={() => setMethods((current) => ({ ...current, emailOtp: false, mobileOtp: false }))}
          email={email}
          onEmailChange={setEmail}
        />
      ) : null}

      {showPassword ? (
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

          {mode === "register" && methods.mobileOtp ? (
            <Input
              label="Mobile number (optional)"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                setPhoneError(undefined);
              }}
              placeholder="98765 43210"
              hint="So you can also sign in with a code by text message."
              error={phoneError}
            />
          ) : null}

          {mode === "register" ? (
            <Input
              label="Referral code (optional)"
              value={referralCode}
              onChange={(event) => setReferralCode(event.target.value.toUpperCase())}
              maxLength={16}
              autoComplete="off"
              hint="From a friend who shops with us. You both get a reward after your first order."
            />
          ) : null}

          {mode === "register" ? (
            <Checkbox label="Email me about offers and new arrivals (you can stop any time)" checked={offers}
              onChange={(event) => setOffers(event.target.checked)} />
          ) : null}

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
      ) : null}

      {/* ------------------------------------------- the other ways in */}
      {codeAvailable && methods.emailPassword ? (
        <p className="mt-5 text-center text-sm">
          <button
            type="button"
            onClick={() => setView(showCode ? "password" : "code")}
            className="text-ink underline underline-offset-4 transition-colors hover:text-copper-700"
          >
            {showCode ? "Use your password instead" : "Use a one-time code instead"}
          </button>
        </p>
      ) : null}

      {methods.providers.length > 0 ? (
        <div className="mt-8">
          <p className="mb-4 flex items-center gap-3 text-xs uppercase tracking-[0.14em] text-ink-400" aria-hidden="true">
            <span className="h-px flex-1 bg-ink-200" />
            or
            <span className="h-px flex-1 bg-ink-200" />
          </p>
          <SocialButtons providers={methods.providers} next={socialNext} />
        </div>
      ) : null}
    </div>
  );
}
