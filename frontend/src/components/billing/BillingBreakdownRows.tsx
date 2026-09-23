import type { BillingBreakdown } from "@/types";

import { cn } from "@/lib/utils/cn";
import { formatMoney } from "@/lib/money";

/**
 * The money breakdown, rendered once.
 *
 * The bag, every checkout step, the order confirmation, the customer invoice,
 * the admin order page and the admin invoice all print these rows from the same
 * `BillingBreakdown`. That is the whole point of computing the breakdown in one
 * service: not just that the arithmetic agrees, but that the *presentation*
 * does — the same labels, in the same order, wherever a shopper or an
 * administrator looks.
 *
 * Two presentational decisions worth stating:
 *
 * - Catalogue savings are shown but **not subtracted**. They are already inside
 *   the subtotal. Rendering them as a deduction is the commonest way a total
 *   stops adding up on screen.
 * - On tax-inclusive pricing the tax lines are marked as included rather than
 *   added, because a customer reading "Tax ₹77" under a subtotal reasonably
 *   expects the total to be ₹77 higher.
 */

export function BillingBreakdownRows({
  breakdown,
  /** Print the CGST/SGST/IGST split rather than a single tax line. */
  detailed = false,
  className,
  tone = "storefront",
}: {
  breakdown: BillingBreakdown;
  detailed?: boolean;
  className?: string;
  tone?: "storefront" | "admin";
}) {
  const muted = tone === "admin" ? "text-admin-muted" : "text-ink-500";
  const strong = tone === "admin" ? "text-admin-ink" : "text-ink";
  const positive = tone === "admin" ? "text-status-good" : "text-sage-600";

  const tax = breakdown.tax;
  const taxSuffix = breakdown.pricesIncludeTax ? " (included)" : "";

  return (
    <dl className={cn("flex flex-col gap-2.5 text-sm", className)}>
      <Row
        label={`Subtotal (${breakdown.itemCount} ${breakdown.itemCount === 1 ? "item" : "items"})`}
        value={formatMoney(breakdown.subtotal)}
        muted={muted}
        strong={strong}
      />

      {breakdown.productDiscount > 0 ? (
        <Row
          label="Product discount"
          value={`− ${formatMoney(breakdown.productDiscount)}`}
          muted={muted}
          strong={positive}
        />
      ) : null}

      {breakdown.couponDiscount > 0 ? (
        <Row
          label={`Coupon discount${breakdown.couponCode ? ` (${breakdown.couponCode})` : ""}`}
          value={`− ${formatMoney(breakdown.couponDiscount)}`}
          muted={muted}
          strong={positive}
        />
      ) : null}

      <Row
        label="Shipping"
        value={breakdown.shipping === 0 ? "Free" : formatMoney(breakdown.shipping)}
        muted={muted}
        strong={breakdown.shipping === 0 ? positive : strong}
      />

      {breakdown.otherCharges > 0 ? (
        <Row
          label="Other charges"
          value={formatMoney(breakdown.otherCharges)}
          muted={muted}
          strong={strong}
        />
      ) : null}

      {tax.totalTax > 0 && detailed ? (
        <>
          <Row
            label="Taxable value"
            value={formatMoney(tax.taxableAmount)}
            muted={muted}
            strong={strong}
          />
          {tax.mode === "intra-state" ? (
            <>
              <Row
                label={`CGST (${(tax.ratePercent / 2).toFixed(tax.ratePercent % 2 === 0 ? 0 : 2)}%)`}
                value={formatMoney(tax.cgst)}
                muted={muted}
                strong={strong}
              />
              <Row
                label={`SGST (${(tax.ratePercent / 2).toFixed(tax.ratePercent % 2 === 0 ? 0 : 2)}%)`}
                value={formatMoney(tax.sgst)}
                muted={muted}
                strong={strong}
              />
            </>
          ) : (
            <Row
              label={`IGST (${tax.ratePercent}%)`}
              value={formatMoney(tax.igst)}
              muted={muted}
              strong={strong}
            />
          )}
        </>
      ) : tax.totalTax > 0 ? (
        <Row
          label={`Tax${taxSuffix}`}
          value={formatMoney(tax.totalTax)}
          muted={muted}
          strong={strong}
        />
      ) : null}
    </dl>
  );
}

function Row({
  label,
  value,
  muted,
  strong,
}: {
  label: string;
  value: string;
  muted: string;
  strong: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={muted}>{label}</dt>
      <dd className={cn("shrink-0 tabular-nums", strong)}>{value}</dd>
    </div>
  );
}

/** The grand-total line, kept separate so callers can place it themselves. */
export function GrandTotalRow({
  breakdown,
  className,
  tone = "storefront",
}: {
  breakdown: BillingBreakdown;
  className?: string;
  tone?: "storefront" | "admin";
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-4 border-t pt-4",
        tone === "admin" ? "border-admin-border" : "border-ink-200",
        className,
      )}
    >
      <span
        className={cn(
          "text-sm font-medium",
          tone === "admin" ? "text-admin-ink" : "text-ink",
        )}
      >
        Grand total
      </span>
      <span
        className={cn(
          "tabular-nums",
          tone === "admin"
            ? "text-lg font-semibold text-admin-ink"
            : "font-display text-xl text-ink",
        )}
      >
        {formatMoney(breakdown.grandTotal)}
      </span>
    </div>
  );
}
