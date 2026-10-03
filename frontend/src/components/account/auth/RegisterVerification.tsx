"use client";

import { useState } from "react";

import type { AuthSession } from "@/types";
import type { IssuedOtp } from "@/types/identity";

import { requestEmailCode, requestPhoneCode, verifyEmailCode, verifyPhoneCode } from "@/services/identityService";

import { CodeStep } from "./CodeStep";

/**
 * After "Create account", when the store confirms new accounts with a code:
 * the code emailed to the new address, then (if a number was given) the one
 * texted to the phone.
 *
 * The account exists already and its token is stored; these steps only
 * confirm the address and number. Either can be left for later — Settings →
 * Security does the same — and `onDone` is called with the session as the
 * server last described it, never with a verification the server didn't
 * confirm.
 */
export function RegisterVerification({
  session,
  verification,
  phoneVerification,
  phone,
  onDone,
}: {
  session: AuthSession;
  verification?: IssuedOtp | null;
  phoneVerification?: IssuedOtp | null;
  /** The number as typed at registration, for asking for another code. */
  phone: string;
  onDone: (session: AuthSession) => void;
}) {
  const [current, setCurrent] = useState(session);
  const [stage, setStage] = useState<"email" | "phone">(verification ? "email" : "phone");

  const afterEmail = (next: AuthSession) => {
    if (phoneVerification) {
      setCurrent(next);
      setStage("phone");
    } else onDone(next);
  };

  if (stage === "email" && verification) {
    return (
      <section aria-labelledby="register-email-code">
        <h2 id="register-email-code" className="mb-4 font-display text-xl text-ink">
          Confirm your email address
        </h2>
        <CodeStep
          key={verification.challengeId}
          issued={verification}
          submitLabel="Confirm email"
          onVerify={async (challengeId, code) => {
            const user = await verifyEmailCode(challengeId, code);
            afterEmail({ ...current, user: { ...current.user, ...user } });
          }}
          onResend={async () => {
            const result = await requestEmailCode();
            if (result.alreadyVerified) {
              afterEmail({ ...current, user: { ...current.user, emailVerified: true } });
              // Nothing more to type: the step is already gone.
              return verification;
            }
            return result;
          }}
          onBack={() => afterEmail(current)}
          backLabel="Do this later"
          hint="Can't see it? Check your spam or promotions folder."
        />
      </section>
    );
  }

  if (phoneVerification) {
    return (
      <section aria-labelledby="register-phone-code">
        <h2 id="register-phone-code" className="mb-4 font-display text-xl text-ink">
          Confirm your mobile number
        </h2>
        <CodeStep
          key={phoneVerification.challengeId}
          issued={phoneVerification}
          submitLabel="Confirm number"
          onVerify={async (challengeId, code) => {
            const security = await verifyPhoneCode(challengeId, code);
            onDone({ ...current, user: { ...current.user, phone: security.phone, phoneVerified: security.phoneVerified } });
          }}
          onResend={() => requestPhoneCode(phone)}
          onBack={() => onDone(current)}
          backLabel="Do this later"
        />
      </section>
    );
  }

  return null;
}
