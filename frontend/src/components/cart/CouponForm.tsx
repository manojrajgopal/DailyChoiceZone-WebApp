"use client";

import { useEffect, useState } from "react";
import { Tag, X } from "lucide-react";

import type { Coupon } from "@/types";

import { Button } from "@/components/ui/Button";
import { getCoupons } from "@/services/cartService";
import { formatPrice } from "@/lib/utils/format";

/**
 * Coupon entry.
 *
 * The codes currently on offer are listed underneath, read from the store —
 * a coupon field with no discoverable codes is a dead end, and an offer the
 * shop is running is not a secret.
 */
export function CouponForm({
  applied,
  subtotal,
  onApply,
  onRemove,
  pendingCode = null,
  error = null,
  compact = false,
}: {
  applied: Coupon | null;
  subtotal: number;
  onApply: (code: string) => Promise<unknown>;
  onRemove: () => void;
  /** A code saved in the bag that is not currently applied. */
  pendingCode?: string | null;
  /** Why `pendingCode` doesn't apply — e.g. the basket fell below its minimum. */
  error?: string | null;
  /** Smaller, for the checkout summary. */
  compact?: boolean;
}) {
  const [code, setCode] = useState("");
  const [isApplying, setIsApplying] = useState(false);
  const [available, setAvailable] = useState<Coupon[]>([]);

  useEffect(() => {
    let active = true;
    getCoupons()
      .then((coupons) => {
        if (active) setAvailable(coupons);
      })
      .catch(() => {
        if (active) setAvailable([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setIsApplying(true);
    try {
      await onApply(code);
      setCode("");
    } finally {
      setIsApplying(false);
    }
  };

  if (applied) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-card border border-sage-500/30 bg-sage-100/40 px-3.5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Tag className="h-4 w-4 shrink-0 text-sage-600" strokeWidth={1.5} aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{applied.code} applied</p>
            <p className="truncate text-xs text-ink-500">{applied.description}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove coupon ${applied.code}`}
          className="shrink-0 rounded-pill p-1.5 text-ink-400 transition-colors hover:bg-shell hover:text-ink"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    );
  }

  const applyNow = async (value: string) => {
    setIsApplying(true);
    try {
      await onApply(value);
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div>
      {compact ? <p className="label-wide mb-2 text-ink-700">Coupon</p> : null}

      {pendingCode && error ? (
        <div
          role="status"
          className="mb-2.5 flex items-start justify-between gap-3 rounded-card border border-clay-200 bg-clay-50 px-3.5 py-2.5"
        >
          <p className="text-xs leading-relaxed text-ink-700">
            <span className="font-medium text-ink">{pendingCode}</span> isn&rsquo;t applied: {error}
          </p>
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 text-xs font-medium text-clay-700 underline underline-offset-2 hover:text-ink"
          >
            Remove
          </button>
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="flex gap-2">
        <label className="flex-1">
          <span className="sr-only">Coupon code</span>
          <input
            type="text"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="Coupon code"
            autoComplete="off"
            spellCheck={false}
            className="h-11 w-full rounded-control border border-ink-200 bg-shell px-3.5 text-sm uppercase tracking-wider text-ink placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-400 focus:border-copper-500"
          />
        </label>

        <Button type="submit" variant="outline" disabled={isApplying || !code.trim()}>
          {isApplying ? "Checking…" : "Apply"}
        </Button>
      </form>

      {available.length > 0 ? (
        <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Coupons you can use">
          {available.map((coupon) => {
            const eligible = subtotal >= coupon.minSubtotal;
            const tag =
              coupon.audience === "members"
                ? "Members"
                : coupon.audience === "selected"
                  ? "Just for you"
                  : coupon.audience === "first-order"
                    ? "First order"
                    : null;
            return (
              <li key={coupon.code}>
                <button
                  type="button"
                  // One tap applies it: typing a code shown on screen is busywork.
                  onClick={() => void applyNow(coupon.code)}
                  disabled={!eligible || isApplying}
                  title={
                    eligible
                      ? coupon.description
                      : `Spend ${formatPrice(coupon.minSubtotal)} to unlock`
                  }
                  // The accessible name must contain the visible label (the
                  // code) as well as the explanation — WCAG 2.5.3.
                  aria-label={
                    eligible
                      ? `${coupon.code} — ${coupon.description}`
                      : `${coupon.code} — spend ${formatPrice(coupon.minSubtotal)} to unlock`
                  }
                  className="rounded-pill border border-dashed border-ink-300 px-2.5 py-1 text-[0.6875rem] tracking-wider text-ink-700 transition-colors hover:border-ink hover:text-ink disabled:cursor-not-allowed disabled:border-ink-100 disabled:text-ink-300"
                >
                  {coupon.code}
                  {tag ? (
                    <span className="ml-1.5 rounded-pill bg-copper-50 px-1.5 py-px text-[0.5625rem] font-medium uppercase tracking-wide text-copper-700">
                      {tag}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
