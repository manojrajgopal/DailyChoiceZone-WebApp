"use client";

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import { PINCODE_PATTERN } from "@/services/deliveryService";
import { getDeliveryEstimate } from "@/services/shippingService";
import type { DeliveryEstimate as Estimate } from "@/types/shipping";

/** How long typing must pause before asking. */
export const ESTIMATE_DEBOUNCE_MS = 400;

/**
 * "Delivery by Thu, 9 Oct" under the PIN code at checkout.
 *
 * A nicety, never a gate: it asks only once a full PIN code has been typed
 * and typing has paused, ignores answers to an older PIN, and says nothing at
 * all when there's no estimate or the courier couldn't be reached. Nothing
 * here can stop or slow the customer moving on.
 */
export function DeliveryEstimate({ pincode, cod, className }: { pincode: string; cod?: boolean; className?: string }) {
  const code = pincode.trim();
  const [result, setResult] = useState<{ code: string; estimate: Estimate } | null>(null);

  useEffect(() => {
    if (!PINCODE_PATTERN.test(code)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      getDeliveryEstimate(code, { cod, signal: controller.signal })
        .then((estimate) => {
          if (!controller.signal.aborted) setResult({ code, estimate });
        })
        .catch(() => {
          // Unknown is fine: checkout carries on exactly as without it.
        });
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [code, cod]);

  const estimate = result && result.code === code && PINCODE_PATTERN.test(code) ? result.estimate : null;
  if (!estimate || estimate.serviceable !== true || !estimate.label) return null;

  return (
    <p role="status" className={cn("flex items-start gap-1.5 text-xs leading-relaxed text-ink-600", className)}>
      <CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" strokeWidth={1.75} aria-hidden="true" />
      <span>
        {estimate.label}
        {estimate.message ? <span className="text-ink-500"> · {estimate.message}</span> : null}
      </span>
    </p>
  );
}
