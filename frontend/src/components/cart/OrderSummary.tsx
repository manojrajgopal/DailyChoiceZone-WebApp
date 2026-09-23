import { Truck } from "lucide-react";

import type { BillingBreakdown, CartTotals } from "@/types";

import { BillingBreakdownRows, GrandTotalRow } from "@/components/billing/BillingBreakdownRows";
import { cn } from "@/lib/utils/cn";
import { formatMoney } from "@/lib/money";
import { formatPrice } from "@/lib/utils/format";

/**
 * The money panel, shared by the bag, every checkout step and the review page.
 *
 * It renders the `BillingBreakdown` produced by `billingService` — the same one
 * the invoice, the order record and the admin order page render. One component
 * over one calculation means the figures a shopper sees cannot drift between
 * the bag and the final confirmation, which is the commonest way a checkout
 * loses trust.
 *
 * `totals` is still taken for the free-delivery nudge, which is a merchandising
 * prompt rather than part of the bill and so has no place in the breakdown.
 */
export function OrderSummary({
  breakdown,
  totals,
  /** Show the CGST/SGST split rather than one tax line. */
  detailedTax = false,
  /** Shown above the figures on checkout steps. */
  children,
  className,
}: {
  breakdown: BillingBreakdown;
  totals: CartTotals;
  detailedTax?: boolean;
  children?: React.ReactNode;
  className?: string;
}) {
  const savings = breakdown.productDiscount + breakdown.couponDiscount;

  return (
    <div className={cn("rounded-card border border-ink-200 bg-shell p-5", className)}>
      <h2 className="label-wide text-ink">Order summary</h2>

      {children ? <div className="mt-4">{children}</div> : null}

      <BillingBreakdownRows breakdown={breakdown} detailed={detailedTax} className="mt-5" />

      <GrandTotalRow breakdown={breakdown} className="mt-4" />

      {savings > 0 ? (
        <p className="mt-2 text-xs text-sage-600">
          You are saving {formatMoney(savings)} on this order.
        </p>
      ) : null}

      {/* Nudge toward free delivery only while it is still achievable. */}
      {totals.freeDeliveryShortfall > 0 && totals.itemCount > 0 ? (
        <p className="mt-4 flex items-start gap-2 rounded-card bg-cream-deep p-3 text-xs leading-relaxed text-ink-700">
          <Truck
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-copper-600"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          Add {formatPrice(totals.freeDeliveryShortfall)} more to get free delivery.
        </p>
      ) : null}
    </div>
  );
}
