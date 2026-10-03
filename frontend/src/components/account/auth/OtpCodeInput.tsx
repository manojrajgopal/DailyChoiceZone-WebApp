"use client";

import { forwardRef } from "react";

import { Input } from "@/components/ui/Field";

export interface OtpCodeInputProps {
  /** How many digits the code has (from the API). */
  length: number;
  value: string;
  onChange: (value: string) => void;
  /** Called once the last digit is in — typed, pasted or filled in by the phone. */
  onComplete?: (value: string) => void;
  label?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
}

/**
 * The box a one-time code is typed into.
 *
 * One input rather than a box per digit: it pastes, autofills from an SMS
 * (`autocomplete="one-time-code"`) and reads to a screen reader as what it is.
 * Anything that isn't a digit is dropped, so "Your code is 123 456" pastes as
 * 123456; extra digits beyond the length are ignored.
 */
export const OtpCodeInput = forwardRef<HTMLInputElement, OtpCodeInputProps>(function OtpCodeInput(
  { length, value, onChange, onComplete, label = "One-time code", hint, error, disabled },
  ref,
) {
  return (
    <Input
      ref={ref}
      label={label}
      hint={hint}
      error={error}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, "").slice(0, length);
        onChange(digits);
        if (digits.length === length && digits !== value) onComplete?.(digits);
      }}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]*"
      spellCheck={false}
      placeholder={"•".repeat(length)}
      required
      inputClassName="text-center font-mono text-xl tracking-[0.5em]"
    />
  );
});
