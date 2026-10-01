"use client";

import { useEffect, useState } from "react";

/** The API's naive UTC timestamps as milliseconds. */
export function utcMs(iso: string): number {
  return new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`).getTime();
}

function parts(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(total / 86400), h: Math.floor((total % 86400) / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

/**
 * Time left until a moment, ticking each second. Display only: when a sale
 * actually ends is decided by the server, which re-prices at checkout.
 * `onDone` fires once it reaches zero, so the page can refresh its prices.
 */
export function Countdown({ until, onDone, className, compact = false }: { until: string; onDone?: () => void; className?: string; compact?: boolean }) {
  const target = utcMs(until);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  const left = now === null ? null : target - now;
  useEffect(() => {
    if (left !== null && left <= 0) onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left !== null && left <= 0]);

  if (left === null) return <span className={className} aria-hidden="true">&nbsp;</span>;
  if (left <= 0) return <span className={className}>Ended</span>;
  const { d, h, m, s } = parts(left);
  const pad = (n: number) => String(n).padStart(2, "0");
  const text = compact
    ? d ? `${d}d ${h}h ${m}m` : `${pad(h)}:${pad(m)}:${pad(s)}`
    : d ? `${d} day${d === 1 ? "" : "s"} ${h} h ${m} min` : `${pad(h)}:${pad(m)}:${pad(s)}`;
  return (
    <span className={className} role="timer" aria-live="off" aria-label={`${d ? `${d} days ` : ""}${h} hours ${m} minutes left`}>
      {text}
    </span>
  );
}
