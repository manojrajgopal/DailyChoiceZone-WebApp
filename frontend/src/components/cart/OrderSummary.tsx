import { Truck } from "lucide-react";

import type { CartTotals } from "@/types";

import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";

/**
 * The money panel, shared by the bag, every checkout step and the review page.
 *
 * One component means the figures a shopper sees can never drift between the
 * bag and the final confirmation — the commonest way a checkout loses trust.
 */
export function OrderSummary({
  totals,
  /** Shown above the totals on checkout steps. */
  children,
  className,
}: {
  totals: CartTotals;
  children?: React.ReactNode;
  className?: string;
}) {
  const savings = totals.catalogueSavings + totals.couponDiscount;

  return (
    <div className={cn("rounded-card border border-ink-200 bg-shell p-5", className)}>
      <h2 className="label-wide text-ink">Order summary</h2>

      {children ? <div className="mt-4">{children}</div> : null}

      <dl className="mt-5 flex flex-col gap-2.5 text-sm">
        <Row
          label={`Subtotal (${totals.itemCount} ${totals.itemCount === 1 ? "item" : "items"})`}
          value={formatPrice(totals.subtotal)}
        />

        {totals.catalogueSavings > 0 ? (
          <Row
            label="Catalogue savings"
            value={`− ${formatPrice(totals.catalogueSavings)}`}
            tone="positive"
          />
        ) : null}

        {totals.couponDiscount > 0 ? (
          <Row
            label={`Coupon${totals.appliedCoupon ? ` (${totals.appliedCoupon.code})` : ""}`}
            value={`− ${formatPrice(totals.couponDiscount)}`}
            tone="positive"
          />
        ) : null}

        <Row
          label="Delivery"
          value={totals.deliveryFee === 0 ? "Free" : formatPrice(totals.deliveryFee)}
          tone={totals.deliveryFee === 0 ? "positive" : "default"}
        />
      </dl>

      <div className="mt-4 flex items-baseline justify-between border-t border-ink-200 pt-4">
        <span className="text-sm font-medium text-ink">Total</span>
        <span className="font-display text-xl text-ink tabular-nums">
          {formatPrice(totals.total)}
        </span>
      </div>

      {savings > 0 ? (
        <p className="mt-2 text-xs text-sage-600">
          You are saving {formatPrice(savings)} on this order.
        </p>
      ) : null}

      {/* Nudge toward free delivery only while it is still achievable. */}
      {totals.freeDeliveryShortfall > 0 && totals.itemCount > 0 ? (
        <p className="mt-4 flex items-start gap-2 rounded-card bg-cream-deep p-3 text-xs leading-relaxed text-ink-700">
          <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
          Add {formatPrice(totals.freeDeliveryShortfall)} more to get free delivery.
        </p>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "positive";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-ink-500">{label}</dt>
      <dd
        className={cn(
          "shrink-0 tabular-nums",
          tone === "positive" ? "text-sage-600" : "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
