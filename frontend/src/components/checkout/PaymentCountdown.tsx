"use client";

import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Time left to pay, counting down to the order's own deadline.
 *
 * The deadline is the server's: a prepaid order holds its items for a few
 * minutes and releases them if the money has not arrived. This shows that, so
 * the release is never a surprise — and calls `onExpire` once when it
 * happens, so the page can stop the payment rather than let somebody pay into
 * an order that no longer exists.
 *
 * It is a display, not the rule. A background tab pauses timers, so this can
 * run slow; the server enforces the deadline regardless and refunds anything
 * that lands after it.
 */
export function PaymentCountdown({
  deadline,
  onExpire,
}: {
  /** Epoch milliseconds, built from the server's own count of seconds left. */
  deadline: number;
  onExpire: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const fired = useRef(false);

  useEffect(() => {
    // Recomputed from the clock each tick rather than decremented, so a tab
    // that was suspended shows the right figure the moment it wakes up.
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const left = Math.max(0, Math.round((deadline - now) / 1000));

  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onExpire();
    }
  }, [left, onExpire]);

  const minutes = Math.floor(left / 60);
  const seconds = left % 60;
  const urgent = left <= 60;

  return (
    <p
      role="timer"
      aria-live={urgent ? "assertive" : "off"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-xs font-medium tabular-nums",
        urgent ? "bg-clay-50 text-clay-700" : "bg-ink-50 text-ink-700",
      )}
    >
      <Clock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      {left > 0 ? (
        <>
          {minutes}:{String(seconds).padStart(2, "0")} left to pay
          <span className="sr-only">
            {" "}
            — your items are held for you until then
          </span>
        </>
      ) : (
        <>Time is up</>
      )}
    </p>
  );
}
