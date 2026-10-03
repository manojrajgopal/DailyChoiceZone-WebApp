"use client";

import { useState } from "react";
import { CreditCard, Loader2, Lock } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import {
  BRAND_NAMES,
  cardBrand,
  cvvLength,
  formatCardNumber,
  formatExpiry,
  toCardDetails,
  validateCard,
  type CardDetails,
  type CardErrors,
  type CardInput,
} from "@/lib/payments/card";
import { CARD_NOTE } from "@/services/payments/razorpayCustom";

const EMPTY: CardInput = { number: "", name: "", expiry: "", cvv: "" };

/**
 * Card details, in our own form.
 *
 * The values live in this component's state only. On "Pay" they are checked,
 * handed to `onPay` (which passes them straight to the gateway — see
 * `razorpayCustom.startCustomPayment`) and cleared at once. Nothing here
 * writes them anywhere else: not a store, not storage, not a log, not the URL.
 * The inputs use the standard `cc-*` autocomplete names, so a browser or
 * password manager can fill a saved card, and `autoComplete="off"` would only
 * push people to type it by hand.
 */
export function CardForm({
  total,
  disabled,
  onPay,
}: {
  /** Formatted, for the button. */
  total: string;
  disabled?: boolean;
  onPay: (card: CardDetails) => void;
}) {
  const [card, setCard] = useState<CardInput>(EMPTY);
  const [errors, setErrors] = useState<CardErrors>({});
  const [touched, setTouched] = useState<Partial<Record<keyof CardInput, boolean>>>({});
  const brand = cardBrand(card.number);
  const codeLength = cvvLength(card.number);

  const set = (key: keyof CardInput, value: string) => {
    const next = { ...card, [key]: value };
    setCard(next);
    // Once a field has been left once, keep its message current as they fix it.
    if (touched[key]) setErrors((current) => ({ ...current, [key]: validateCard(next)[key] }));
  };

  const leave = (key: keyof CardInput) => {
    setTouched((current) => ({ ...current, [key]: true }));
    if (card[key]) setErrors((current) => ({ ...current, [key]: validateCard(card)[key] }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const problems = validateCard(card);
    setErrors(problems);
    setTouched({ number: true, name: true, expiry: true, cvv: true });
    if (Object.values(problems).some(Boolean)) {
      const first = (["number", "name", "expiry", "cvv"] as const).find((key) => problems[key]);
      if (first) document.getElementById(`card-${first}`)?.focus();
      return;
    }
    const details = toCardDetails(card);
    // Gone from the page as soon as it has been handed over.
    setCard(EMPTY);
    setTouched({});
    onPay(details);
  };

  return (
    <form onSubmit={submit} noValidate aria-label="Card details" className="flex flex-col gap-3">
      <Field id="card-number" label="Card number" error={errors.number}>
        <div className="relative">
          <input
            id="card-number"
            name="cardnumber"
            inputMode="numeric"
            autoComplete="cc-number"
            spellCheck={false}
            placeholder="1234 5678 9012 3456"
            value={card.number}
            onChange={(event) => set("number", formatCardNumber(event.target.value))}
            onBlur={() => leave("number")}
            aria-invalid={Boolean(errors.number)}
            aria-describedby={errors.number ? "card-number-error" : "card-number-brand"}
            disabled={disabled}
            className={input(errors.number, "pr-28 tracking-wide tabular-nums")}
          />
          <span
            id="card-number-brand"
            aria-live="polite"
            className="pointer-events-none absolute right-3 top-1/2 inline-flex -translate-y-1/2 items-center gap-1.5 text-xs font-medium text-ink-500"
          >
            <CreditCard className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
            {card.number ? BRAND_NAMES[brand] : ""}
          </span>
        </div>
      </Field>

      <Field id="card-name" label="Name on card" error={errors.name}>
        <input
          id="card-name"
          name="ccname"
          autoComplete="cc-name"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="As printed on the card"
          value={card.name}
          maxLength={60}
          onChange={(event) => set("name", event.target.value)}
          onBlur={() => leave("name")}
          aria-invalid={Boolean(errors.name)}
          aria-describedby={errors.name ? "card-name-error" : undefined}
          disabled={disabled}
          className={input(errors.name)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field id="card-expiry" label="Expiry (MM / YY)" error={errors.expiry}>
          <input
            id="card-expiry"
            name="cc-exp"
            inputMode="numeric"
            autoComplete="cc-exp"
            placeholder="MM / YY"
            value={card.expiry}
            onChange={(event) => set("expiry", formatExpiry(event.target.value))}
            onBlur={() => leave("expiry")}
            aria-invalid={Boolean(errors.expiry)}
            aria-describedby={errors.expiry ? "card-expiry-error" : undefined}
            disabled={disabled}
            className={input(errors.expiry, "tabular-nums")}
          />
        </Field>
        <Field id="card-cvv" label={codeLength === 4 ? "Security code" : "CVV"} error={errors.cvv}>
          <input
            id="card-cvv"
            name="cvc"
            type="password"
            inputMode="numeric"
            autoComplete="cc-csc"
            placeholder={codeLength === 4 ? "4 digits" : "3 digits"}
            value={card.cvv}
            maxLength={codeLength}
            onChange={(event) => set("cvv", event.target.value.replace(/\D/g, "").slice(0, codeLength))}
            onBlur={() => leave("cvv")}
            aria-invalid={Boolean(errors.cvv)}
            aria-describedby={errors.cvv ? "card-cvv-error" : undefined}
            disabled={disabled}
            className={input(errors.cvv, "tabular-nums")}
          />
        </Field>
      </div>

      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-500">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        {CARD_NOTE}
      </p>

      <Button type="submit" fullWidth disabled={disabled} className="mt-1">
        {disabled ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            Processing…
          </>
        ) : (
          <>Pay {total}</>
        )}
      </Button>
    </form>
  );
}

function input(error?: string, extra?: string) {
  return cn(
    "h-11 w-full rounded-control border bg-shell px-3 text-sm text-ink outline-none transition-colors",
    "placeholder:text-ink-300 focus:border-copper-500 disabled:opacity-60",
    error ? "border-danger" : "border-ink-200",
    extra,
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-ink-700">{label}</label>
      {children}
      {error ? <p id={`${id}-error`} role="alert" className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
