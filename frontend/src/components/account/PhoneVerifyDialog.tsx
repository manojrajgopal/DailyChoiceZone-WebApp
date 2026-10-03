"use client";

import { useState } from "react";

import type { AccountSecurity, IssuedOtp } from "@/types/identity";

import { CodeStep } from "@/components/account/auth/CodeStep";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Field";
import { normaliseMobile } from "@/lib/utils/phone";
import { codeOf, messageOf, requestPhoneCode, verifyPhoneCode } from "@/services/identityService";

/**
 * Add, change or confirm the account's mobile number with a texted code.
 *
 * The number becomes a sign-in number only when the server has checked the
 * code; `onVerified` gets the Security summary it sent back, and nothing
 * here marks a number as confirmed on its own.
 */
export function PhoneVerifyDialog({
  open,
  onOpenChange,
  initialPhone = "",
  title = "Verify your mobile number",
  onVerified,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPhone?: string;
  title?: string;
  onVerified: (security: AccountSecurity) => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="We'll text a code to the number. Once it's confirmed you can also sign in with it."
      className="max-w-md"
    >
      {/* Mounted only while open, so every opening starts at the first step. */}
      {open ? <PhoneVerifyFlow initialPhone={initialPhone} onVerified={onVerified} onCancel={() => onOpenChange(false)} /> : null}
    </Modal>
  );
}

function PhoneVerifyFlow({
  initialPhone,
  onVerified,
  onCancel,
}: {
  initialPhone: string;
  onVerified: (security: AccountSecurity) => void;
  onCancel: () => void;
}) {
  const [phone, setPhone] = useState(normaliseMobile(initialPhone) ?? initialPhone);
  const [issued, setIssued] = useState<IssuedOtp | null>(null);
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const number = normaliseMobile(phone);
    if (!number) {
      setFieldError("Enter a 10-digit mobile number.");
      return;
    }
    setBusy(true);
    setError(undefined);
    setFieldError(undefined);
    try {
      setIssued(await requestPhoneCode(number));
    } catch (failure) {
      if (codeOf(failure) === "PHONE_INVALID") setFieldError(messageOf(failure));
      else setError(messageOf(failure, "We couldn't send the code just now. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  if (issued) {
    return (
      <CodeStep
        key={issued.challengeId}
        issued={issued}
        submitLabel="Confirm number"
        onVerify={async (challengeId, code) => {
          onVerified(await verifyPhoneCode(challengeId, code));
        }}
        onResend={() => requestPhoneCode(normaliseMobile(phone) ?? phone)}
        onBack={() => setIssued(null)}
        backLabel="Use a different number"
      />
    );
  }

  return (
    <form onSubmit={send} className="flex flex-col gap-5">
      <Input
        label="Mobile number"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={phone}
        onChange={(event) => {
          setPhone(event.target.value);
          setFieldError(undefined);
        }}
        placeholder="98765 43210"
        error={fieldError}
        required
      />
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !phone.trim()}>
          {busy ? "Sending…" : "Send code"}
        </Button>
      </div>
    </form>
  );
}
