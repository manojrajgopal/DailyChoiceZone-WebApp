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
 * The available codes are listed underneath, because this is a demo storefront
 * and a coupon field with no discoverable codes is a dead end. On a real store
 * that list would come from an offers endpoint, or be removed entirely.
 */
export function CouponForm({
  applied,
  subtotal,
  onApply,
  onRemove,
}: {
  applied: Coupon | null;
  subtotal: number;
  onApply: (code: string) => Promise<unknown>;
  onRemove: () => void;
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

  return (
    <div>
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
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {available.map((coupon) => {
            const eligible = subtotal >= coupon.minSubtotal;
            return (
              <li key={coupon.code}>
                <button
                  type="button"
                  onClick={() => setCode(coupon.code)}
                  disabled={!eligible}
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
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
