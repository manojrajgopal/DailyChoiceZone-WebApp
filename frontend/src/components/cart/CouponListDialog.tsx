"use client";

import {
  CalendarDays,
  Repeat,
  ShoppingBag,
  Tag,
  Truck,
  Users,
} from "lucide-react";

import type { Coupon } from "@/types";

import { Modal } from "@/components/ui/Dialog";
import { formatPrice } from "@/lib/utils/format";
import { formatLocalDate } from "@/lib/utils/dateInput";
import { cn } from "@/lib/utils/cn";

/** What the coupon gives, in one line: "10% off, up to ₹200". */
export function couponBenefit(coupon: Coupon): string {
  if (coupon.type === "free-shipping") return "Free delivery";
  if (coupon.type === "flat") return `${formatPrice(coupon.value)} off`;
  const cap = coupon.maxDiscount
    ? `, up to ${formatPrice(coupon.maxDiscount)}`
    : "";
  return `${coupon.value}% off${cap}`;
}

const AUDIENCE_LABEL: Record<string, string> = {
  members: "Members only",
  selected: "Just for you",
  "first-order": "First order only",
};

/** Why this coupon can't be applied to this bag right now, if it can't. */
export function couponBlocker(coupon: Coupon, subtotal: number): string | null {
  if (coupon.soldOut) return "All claimed";
  if (
    coupon.perCustomerLimit != null &&
    coupon.timesUsed != null &&
    coupon.timesUsed >= coupon.perCustomerLimit
  ) {
    return "You've used this one";
  }
  if (subtotal < coupon.minSubtotal)
    return `Add ${formatPrice(coupon.minSubtotal - subtotal)} more`;
  return null;
}

function usesLine(coupon: Coupon): string | null {
  const limit = coupon.perCustomerLimit;
  if (limit == null) return null;
  const times = limit === 1 ? "once" : `${limit} times`;
  if (coupon.timesUsed == null) return `Usable ${times} per customer`;
  const left = Math.max(0, limit - coupon.timesUsed);
  return left === 0
    ? `Usable ${times} per customer — you've used it`
    : `Usable ${times} per customer — ${left} ${left === 1 ? "use" : "uses"} left for you`;
}

/**
 * Every coupon this shopper can use, with what each one does.
 *
 * A row of bare codes told a shopper nothing about which to pick; this lists
 * the saving, the minimum order, the last day and the limits, with the
 * reason a code can't be used yet next to its button.
 */
export function CouponListDialog({
  open,
  onOpenChange,
  coupons,
  subtotal,
  appliedCode,
  busy,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coupons: Coupon[];
  subtotal: number;
  appliedCode: string | null;
  busy: boolean;
  onApply: (code: string) => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Coupons for you"
      description={`${coupons.length} ${coupons.length === 1 ? "offer" : "offers"} you can use. Your bag: ${formatPrice(subtotal)}.`}
      className="max-w-lg"
    >
      {coupons.length === 0 ? (
        <p className="text-sm text-ink-500">
          No coupons right now — check back soon.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {coupons.map((coupon) => {
            const blocker = couponBlocker(coupon, subtotal);
            const isApplied = appliedCode === coupon.code;
            const audience = coupon.audience
              ? AUDIENCE_LABEL[coupon.audience]
              : undefined;
            const uses = usesLine(coupon);
            const endsAt = formatLocalDate(coupon.endsAt);
            const Icon = coupon.type === "free-shipping" ? Truck : Tag;

            return (
              <li
                key={coupon.code}
                className={cn(
                  "rounded-card border p-4",
                  isApplied
                    ? "border-sage-500/40 bg-sage-50"
                    : "border-ink-200 bg-shell",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-base font-medium text-ink">
                      <Icon
                        className="h-4 w-4 shrink-0 text-copper-700"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      {couponBenefit(coupon)}
                    </p>
                    <p className="mt-1.5 inline-flex rounded-control border border-dashed border-ink-300 px-2 py-0.5 font-mono text-xs tracking-wider text-ink-700">
                      {coupon.code}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => onApply(coupon.code)}
                    disabled={Boolean(blocker) || isApplied || busy}
                    className="shrink-0 rounded-control border border-ink px-3.5 py-2 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-ink transition-colors hover:bg-ink hover:text-cream disabled:cursor-not-allowed disabled:border-ink-200 disabled:text-ink-400 disabled:hover:bg-transparent"
                  >
                    {isApplied ? "Applied" : "Apply"}
                  </button>
                </div>

                {coupon.description ? (
                  <p className="mt-2.5 text-sm leading-relaxed text-ink-700">
                    {coupon.description}
                  </p>
                ) : null}

                <dl className="mt-3 grid gap-1.5 text-xs text-ink-500">
                  <div className="flex items-center gap-2">
                    <ShoppingBag
                      className="h-3.5 w-3.5 shrink-0"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                    <dt className="sr-only">Minimum order</dt>
                    <dd>
                      {coupon.minSubtotal > 0
                        ? `Minimum order ${formatPrice(coupon.minSubtotal)}`
                        : "No minimum order"}
                    </dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <CalendarDays
                      className="h-3.5 w-3.5 shrink-0"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                    <dt className="sr-only">Valid until</dt>
                    <dd>{endsAt ? `Valid until ${endsAt}` : "No end date"}</dd>
                  </div>
                  {uses ? (
                    <div className="flex items-center gap-2">
                      <Repeat
                        className="h-3.5 w-3.5 shrink-0"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      <dt className="sr-only">Limit</dt>
                      <dd>{uses}</dd>
                    </div>
                  ) : null}
                  {audience ? (
                    <div className="flex items-center gap-2">
                      <Users
                        className="h-3.5 w-3.5 shrink-0"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      <dt className="sr-only">Who can use it</dt>
                      <dd>{audience}</dd>
                    </div>
                  ) : null}
                </dl>

                {blocker && !isApplied ? (
                  <p className="mt-2.5 text-xs font-medium text-clay-700">
                    {blocker}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
