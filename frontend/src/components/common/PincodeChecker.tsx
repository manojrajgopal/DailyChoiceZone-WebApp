"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, MapPin, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { PINCODE_PATTERN, checkPincode, type PincodeCheck } from "@/services/deliveryService";

const REMEMBERED = "dcz.pincode";

function remembered(): string {
  try {
    return window.localStorage.getItem(REMEMBERED) ?? "";
  } catch {
    return "";
  }
}

function remember(pincode: string): void {
  try {
    window.localStorage.setItem(REMEMBERED, pincode);
  } catch {
    /* a convenience only */
  }
}

/**
 * The serviceability of a pincode, looked up once it's a full six digits.
 * `null` while there's nothing to look up.
 */
export function usePincodeCheck(pincode: string): {
  result: PincodeCheck | null;
  loading: boolean;
  error: string | null;
} {
  const code = pincode.trim();
  const [state, setState] = useState<{ code: string; result: PincodeCheck | null; error: string | null }>({
    code: "",
    result: null,
    error: null,
  });

  useEffect(() => {
    if (!PINCODE_PATTERN.test(code)) return;
    let live = true;
    const timer = setTimeout(() => {
      checkPincode(code)
        .then((result) => live && setState({ code, result, error: null }))
        .catch((error) =>
          live &&
          setState({
            code,
            result: null,
            error: error instanceof ApiError ? error.message : "We couldn't check this pincode just now.",
          }),
        );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code]);

  if (!PINCODE_PATTERN.test(code)) return { result: null, loading: false, error: null };
  const current = state.code === code;
  return { result: current ? state.result : null, loading: !current, error: current ? state.error : null };
}

/** One line under a pincode: where it is, when it arrives, and what's available there. */
export function PincodeStatus({ check, className }: { check: PincodeCheck; className?: string }) {
  if (!check.serviceable) {
    return (
      <p role="alert" className={cn("flex items-start gap-1.5 text-xs leading-relaxed text-[#a12b2b]", className)}>
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        {check.reason || "Sorry, we don't deliver to this pincode yet."}
      </p>
    );
  }
  const place = [check.city, check.state].filter(Boolean).join(", ");
  const notes = [
    !check.codAvailable ? "Cash on delivery isn't available here" : null,
    !check.expressAvailable ? "Express delivery isn't available here" : null,
  ].filter(Boolean);
  return (
    <div role="status" className={cn("text-xs leading-relaxed text-ink-600", className)}>
      <p className="flex items-start gap-1.5">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#0a6b0a]" strokeWidth={1.75} aria-hidden="true" />
        <span>
          We deliver to {check.pincode}
          {place ? ` (${place})` : ""}
          {check.estimate ? ` — arrives by ${check.estimate}` : ""}.
          {check.listed && check.deliveryFee !== null
            ? ` Delivery ${check.deliveryFee === 0 ? "free" : formatPrice(check.deliveryFee)}${
                check.freeDeliveryThreshold && check.deliveryFee > 0
                  ? `, free over ${formatPrice(check.freeDeliveryThreshold)}`
                  : ""
              }.`
            : ""}
        </span>
      </p>
      {notes.length ? <p className="mt-1 pl-5 text-ink-500">{notes.join(" · ")}.</p> : null}
    </div>
  );
}

/** "Check delivery to your pincode" — for the product page. Remembers the last pincode on this device. */
export function PincodeChecker() {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState("");
  // Restore the last pincode after hydration, so server and client markup agree.
  useEffect(() => {
    const last = remembered();
    if (PINCODE_PATTERN.test(last)) {
      setValue(last);
      setSubmitted(last);
    }
  }, []);
  const { result, loading, error } = usePincodeCheck(submitted);
  const invalid = submitted !== "" && !PINCODE_PATTERN.test(submitted);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const code = value.trim();
    setSubmitted(code);
    if (PINCODE_PATTERN.test(code)) remember(code);
  };

  return (
    <div>
      <form onSubmit={submit} className="flex items-stretch gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Delivery pincode</span>
          <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" strokeWidth={1.5} aria-hidden="true" />
          <input
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            value={value}
            onChange={(event) => setValue(event.target.value.replace(/\D/g, ""))}
            placeholder="Enter delivery pincode"
            className="h-10 w-full rounded-card border border-ink-200 bg-shell pl-9 pr-3 text-sm text-ink placeholder:text-ink-400 hover:border-ink-400 focus:border-ink"
          />
        </label>
        <button
          type="submit"
          className="shrink-0 rounded-card border border-ink px-4 text-sm font-medium text-ink transition-colors hover:bg-ink hover:text-cream"
        >
          Check
        </button>
      </form>
      <div className="mt-2 min-h-[1rem]" aria-live="polite">
        {invalid ? (
          <p className="text-xs text-[#a12b2b]">Enter a valid 6-digit pincode.</p>
        ) : loading ? (
          <p className="text-xs text-ink-500">Checking…</p>
        ) : error ? (
          <p className="text-xs text-[#a12b2b]">{error}</p>
        ) : result ? (
          <PincodeStatus check={result} />
        ) : null}
      </div>
    </div>
  );
}
