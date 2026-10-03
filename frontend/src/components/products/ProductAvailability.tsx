"use client";

import { useEffect, useRef, useState } from "react";
import { Banknote, CheckCircle2, MapPin, TriangleAlert, Truck, Zap } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { PINCODE_PATTERN } from "@/services/deliveryService";
import { checkProductAvailability, type ProductAvailability as Answer } from "@/services/discoveryService";

/** Shared with the plain pincode checker, so a pincode entered anywhere is remembered everywhere. */
const REMEMBERED = "dcz.pincode";
/** Answers reused for a minute: changing colour and back shouldn't ask again. Checkout always re-checks. */
const FRESH_MS = 60_000;
const answers = new Map<string, { at: number; value: Answer }>();

/** For tests. */
export function resetAvailabilityCache(): void {
  answers.clear();
}

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
 * The answer for this product, variant and quantity at `pincode` — `null`
 * until there's a full pincode. Requests are debounced, the one in flight is
 * cancelled when the variant changes, and recent answers are reused.
 */
export function useProductAvailability(
  productId: string,
  pincode: string,
  variant: { size: string | null; color: string | null; quantity: number },
) {
  const { size, color, quantity } = variant;
  const key = `${productId}|${pincode}|${size ?? ""}|${color ?? ""}|${quantity}`;
  const [state, setState] = useState<{ key: string; value: Answer | null; error: string | null }>({
    key: "",
    value: null,
    error: null,
  });

  useEffect(() => {
    if (!PINCODE_PATTERN.test(pincode)) return;
    const cached = answers.get(key);
    if (cached && Date.now() - cached.at < FRESH_MS) {
      setState({ key, value: cached.value, error: null });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkProductAvailability(productId, { pincode, size, color, quantity }, controller.signal)
        .then((value) => {
          answers.set(key, { at: Date.now(), value });
          setState({ key, value, error: null });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setState({
            key,
            value: null,
            error: error instanceof ApiError ? error.message : "We couldn't check delivery just now. Please try again.",
          });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, productId, pincode, size, color, quantity]);

  if (!PINCODE_PATTERN.test(pincode)) return { answer: null, loading: false, error: null };
  const current = state.key === key;
  return { answer: current ? state.value : null, loading: !current, error: current ? state.error : null };
}

/**
 * "Check availability" on the product page.
 *
 * Whether *this* variant can be delivered to the pincode, when, whether cash
 * on delivery and express are on offer there, and what delivery costs — from
 * the store's own pincode list, stock and the product's own delivery rules.
 * For information: checkout asks all of it again when the order is placed.
 */
export function ProductAvailability({
  productId,
  size,
  color,
  quantity,
  needsSize,
}: {
  productId: string;
  size: string | null;
  color: string | null;
  quantity: number;
  needsSize: boolean;
}) {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Restore the last pincode after hydration, so server and client markup agree.
  useEffect(() => {
    const last = remembered();
    if (PINCODE_PATTERN.test(last)) {
      setValue(last);
      setSubmitted(last);
    }
  }, []);

  const { answer, loading, error } = useProductAvailability(productId, submitted, { size, color, quantity });
  const invalid = submitted !== "" && !PINCODE_PATTERN.test(submitted);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const code = value.trim();
    setSubmitted(code);
    if (PINCODE_PATTERN.test(code)) remember(code);
    else inputRef.current?.focus();
  };

  return (
    <div>
      <form onSubmit={submit} className="flex items-stretch gap-2" aria-label="Check availability">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Delivery pincode</span>
          <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" strokeWidth={1.5} aria-hidden="true" />
          <input
            ref={inputRef}
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            value={value}
            onChange={(event) => setValue(event.target.value.replace(/\D/g, ""))}
            placeholder="Enter delivery pincode"
            aria-invalid={invalid}
            aria-describedby="availability-result"
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

      <div id="availability-result" className="mt-2 min-h-[1rem]" aria-live="polite">
        {invalid ? (
          <p className="text-xs text-danger">Enter a valid 6-digit pincode.</p>
        ) : loading ? (
          <p className="text-xs text-ink-500">Checking availability…</p>
        ) : error ? (
          <p role="alert" className="text-xs text-danger">{error}</p>
        ) : answer ? (
          <AvailabilityResult answer={answer} needsSize={needsSize} />
        ) : null}
      </div>
    </div>
  );
}

export function AvailabilityResult({ answer, needsSize }: { answer: Answer; needsSize: boolean }) {
  const place = [answer.location.city, answer.location.state].filter(Boolean).join(", ");

  if (!answer.deliverable || answer.status === "out-of-stock" || answer.status === "limited") {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-xs leading-relaxed text-danger">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        <span>
          {answer.message}
          {answer.deliverable && answer.estimatedDelivery && answer.status === "limited"
            ? ` Delivery to ${answer.pincode} is available.` : ""}
        </span>
      </p>
    );
  }

  const fee = answer.deliveryFee;
  return (
    <div role="status" className="flex flex-col gap-2 text-xs leading-relaxed text-ink-600">
      <p className="flex items-start gap-1.5 font-medium text-ink">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sage-600" strokeWidth={1.75} aria-hidden="true" />
        <span>
          {answer.status === "select-variant" || (needsSize && !answer.variant.size)
            ? `We deliver to ${answer.pincode}${place ? ` (${place})` : ""}. Choose a size to check it's in stock.`
            : `Available for delivery to ${answer.pincode}${place ? ` (${place})` : ""}`}
        </span>
      </p>
      <dl className="grid gap-1.5 pl-5 sm:grid-cols-2">
        {answer.estimatedDelivery ? (
          <Row icon={Truck} label="Estimated delivery" value={answer.estimatedDelivery.label} />
        ) : null}
        <Row
          icon={Truck}
          label="Delivery charge"
          value={fee === null ? "—" : fee === 0 ? "Free" : formatPrice(fee)}
          hint={fee && answer.freeDeliveryThreshold ? `Free over ${formatPrice(answer.freeDeliveryThreshold)}` : undefined}
        />
        <Row
          icon={Banknote}
          label="Cash on delivery"
          value={answer.codAvailable ? "Available" : "Not available"}
          hint={answer.codAvailable
            ? answer.cod.fee ? `${formatPrice(answer.cod.fee)} fee` : undefined
            : answer.cod.reason || undefined}
          muted={!answer.codAvailable}
        />
        <Row
          icon={Zap}
          label="Express delivery"
          value={answer.expressAvailable && answer.express.estimatedDelivery
            ? `By ${answer.express.estimatedDelivery.latestLabel}`
            : "Not available"}
          hint={answer.expressAvailable && answer.express.fee ? formatPrice(answer.express.fee) : undefined}
          muted={!answer.expressAvailable}
        />
      </dl>
      {answer.note ? <p className="pl-5 text-ink-500">{answer.note}</p> : null}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  value,
  hint,
  muted = false,
}: {
  icon: typeof Truck;
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", muted ? "text-ink-300" : "text-copper-600")}
        strokeWidth={1.5} aria-hidden="true" />
      <div>
        <dt className="text-ink-500">{label}</dt>
        <dd className={cn("font-medium", muted ? "text-ink-500" : "text-ink")}>
          {value}
          {hint ? <span className="ml-1 font-normal text-ink-500">· {hint}</span> : null}
        </dd>
      </div>
    </div>
  );
}
