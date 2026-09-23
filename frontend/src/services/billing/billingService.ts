import billingConfigJson from "@/data/billing/billing-config.json";

import type {
  BillingBreakdown,
  BillingConfig,
  CartTotals,
  InvoiceLine,
  Money,
  ResolvedCartLine,
  TaxBreakdown,
} from "@/types";

import { OVERLAY_KEYS, readDocument, writeDocument } from "@/lib/admin/mock-store";
import { allocate, clampTo, percentOf, sum, toMinor } from "@/lib/money";

import { EMPTY_TAX, addTax, calculateTax, combinedRate, getTaxConfig, ratesFor, taxModeFor } from "./taxService";

/**
 * Billing arithmetic.
 *
 * **This is the only place order money is worked out.** The bag, every checkout
 * step, the placed order, the invoice, the admin order page and the reports all
 * render the `BillingBreakdown` this file produces. A component that did its own
 * subtraction would eventually disagree with one that did not, and a checkout
 * that quotes two different totals has already lost the sale.
 *
 * Amounts are integer minor units throughout — see `lib/money.ts`.
 *
 * Future: `POST /billing/quote` returns this breakdown and the server becomes
 * the authority; this file stays as the optimistic local estimate so the
 * figures still update the instant a quantity changes. The shape does not move,
 * so no caller changes.
 */

const CONFIG = billingConfigJson as BillingConfig;

export function getBillingConfig(): BillingConfig {
  return readDocument(OVERLAY_KEYS.billingConfig, CONFIG);
}

export function saveBillingConfig(config: BillingConfig): BillingConfig {
  return writeDocument(OVERLAY_KEYS.billingConfig, config);
}

/* ------------------------------------------------------------ the components */

/** Line values at selling price, before any order-level discount. */
export function calculateSubtotal(lines: { unitPrice: Money; quantity: number }[]): Money {
  return sum(lines.map((line) => line.unitPrice * line.quantity));
}

/**
 * Savings already built into the selling prices.
 *
 * Shown because it is real money off, but it is *not* subtracted again — the
 * subtotal is already net of it. Presenting it as a further deduction is the
 * classic way a cart total stops adding up.
 */
export function calculateProductDiscount(
  lines: { unitPrice: Money; listPrice: Money; quantity: number }[],
): Money {
  return sum(lines.map((line) => Math.max(0, line.listPrice - line.unitPrice) * line.quantity));
}

/** A coupon's value against a subtotal. Never more than the subtotal. */
export function calculateCouponDiscount(
  subtotal: Money,
  coupon: { type: "percent" | "flat" | "free-shipping"; value: number; minSubtotal: number; maxDiscount?: number } | null,
): Money {
  if (!coupon) return 0;
  if (subtotal < toMinor(coupon.minSubtotal)) return 0;

  if (coupon.type === "percent") {
    const raw = percentOf(subtotal, coupon.value);
    const cap = typeof coupon.maxDiscount === "number" ? toMinor(coupon.maxDiscount) : undefined;
    return clampTo(cap === undefined ? raw : Math.min(raw, cap), subtotal);
  }

  if (coupon.type === "flat") return clampTo(toMinor(coupon.value), subtotal);

  // free-shipping waives delivery rather than reducing the goods value.
  return 0;
}

/**
 * Delivery.
 *
 * Two rules carried over from the cart, both easy to get subtly wrong:
 * the threshold is tested against the *pre-coupon* subtotal, so applying a
 * coupon never quietly adds a fee back; and it waives the *standard* fee only,
 * because an express upgrade is a paid service whatever the basket is worth.
 */
export function calculateShipping({
  subtotal,
  itemCount,
  standardFee,
  freeThreshold,
  selectedFee,
  isUpgrade,
  couponWaivesShipping,
}: {
  subtotal: Money;
  itemCount: number;
  standardFee: Money;
  freeThreshold: Money;
  selectedFee?: Money;
  isUpgrade?: boolean;
  couponWaivesShipping?: boolean;
}): Money {
  if (itemCount === 0) return 0;
  if (isUpgrade && selectedFee !== undefined) return selectedFee;
  if (couponWaivesShipping || subtotal >= freeThreshold) return 0;
  return standardFee;
}

export { calculateTax };

/** Everything, added up. Kept separate so the order of operations is visible. */
export function calculateGrandTotal({
  subtotal,
  couponDiscount,
  shipping,
  otherCharges,
  tax,
  pricesIncludeTax,
}: {
  subtotal: Money;
  couponDiscount: Money;
  shipping: Money;
  otherCharges: Money;
  tax: Money;
  pricesIncludeTax: boolean;
}): Money {
  const goods = Math.max(0, subtotal - couponDiscount);
  // When prices include tax it is already inside `goods`; adding it again
  // would charge it twice.
  const taxToAdd = pricesIncludeTax ? 0 : tax;
  return Math.max(0, goods + shipping + otherCharges + taxToAdd);
}

/* --------------------------------------------------------------- the picture */

export interface BillingInput {
  lines: {
    productId: string;
    name: string;
    sku: string;
    category: string | null;
    size: string | null;
    color: string | null;
    quantity: number;
    /** What is actually charged per unit. */
    unitPrice: Money;
    /** List price, for the savings figure. */
    listPrice: Money;
  }[];
  coupon: { code: string; type: "percent" | "flat" | "free-shipping"; value: number; minSubtotal: number; maxDiscount?: number } | null;
  shipping: Money;
  otherCharges: Money;
  /** The state tax is charged against — the billing address's state. */
  placeOfSupply: string;
}

/**
 * The one calculation.
 *
 * Tax is computed per line rather than once on the total, because rates vary by
 * category and an invoice has to show the tax against each item. The order-level
 * coupon is apportioned across lines first, by value, using `allocate` so the
 * parts sum back exactly — otherwise the line taxes would not reconcile with
 * the invoice total, which is the error an auditor finds first.
 */
export function calculateBilling(input: BillingInput): {
  breakdown: BillingBreakdown;
  lines: InvoiceLine[];
} {
  const config = getTaxConfig();
  const billing = getBillingConfig();
  const mode = taxModeFor(input.placeOfSupply, config);

  const itemCount = input.lines.reduce((count, line) => count + line.quantity, 0);
  const subtotal = calculateSubtotal(input.lines);
  const productDiscount = calculateProductDiscount(input.lines);
  const couponDiscount = calculateCouponDiscount(subtotal, input.coupon);

  // Spread the coupon across lines in proportion to what each contributed.
  const lineValues = input.lines.map((line) => line.unitPrice * line.quantity);
  const lineDiscounts = allocate(couponDiscount, lineValues);

  let tax: TaxBreakdown = EMPTY_TAX;

  const lines: InvoiceLine[] = input.lines.map((line, index) => {
    const lineSubtotal = line.unitPrice * line.quantity;
    const discount = lineDiscounts[index] ?? 0;
    const chargeable = Math.max(0, lineSubtotal - discount);
    const lineTax = calculateTax(chargeable, input.placeOfSupply, line.category, config);

    tax = addTax(tax, lineTax);

    const rates = ratesFor(line.category, config);

    return {
      productId: line.productId,
      name: line.name,
      sku: line.sku,
      // A real HSN code comes from the product record; derived here so the
      // column is populated with something traceable rather than invented.
      hsn: hsnFor(line.category),
      size: line.size,
      color: line.color,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineSubtotal,
      discount,
      taxableAmount: lineTax.taxableAmount,
      taxRatePercent: mode === "none" ? 0 : mode === "intra-state" ? rates.cgst + rates.sgst : rates.igst,
      cgst: lineTax.cgst,
      sgst: lineTax.sgst,
      igst: lineTax.igst,
      tax: lineTax.totalTax,
      lineTotal: config.pricesIncludeTax ? chargeable : chargeable + lineTax.totalTax,
    };
  });

  const grandTotal = calculateGrandTotal({
    subtotal,
    couponDiscount,
    shipping: input.shipping,
    otherCharges: input.otherCharges,
    tax: tax.totalTax,
    pricesIncludeTax: config.pricesIncludeTax,
  });

  return {
    breakdown: {
      currency: billing.currency.code,
      itemCount,
      subtotal,
      productDiscount,
      couponDiscount,
      couponCode: input.coupon?.code ?? null,
      shipping: input.shipping,
      otherCharges: input.otherCharges,
      taxableAmount: tax.taxableAmount,
      tax,
      grandTotal,
      pricesIncludeTax: config.pricesIncludeTax,
    },
    lines,
  };
}

/**
 * Build the billing input from a resolved cart.
 *
 * This is the bridge between the catalogue's whole-rupee prices and the billing
 * domain's minor units, and it is the only place the conversion happens.
 */
export function billingInputFromCart(
  lines: ResolvedCartLine[],
  totals: CartTotals,
  placeOfSupply: string,
  otherCharges: Money = 0,
): BillingInput {
  return {
    lines: lines.map((line) => ({
      productId: line.product.id,
      name: line.product.name,
      sku: line.product.sku,
      category: line.product.category,
      size: line.size,
      color: line.color,
      quantity: line.quantity,
      unitPrice: toMinor(line.product.price),
      listPrice: toMinor(line.product.originalPrice),
    })),
    coupon: totals.appliedCoupon
      ? {
          code: totals.appliedCoupon.code,
          type: totals.appliedCoupon.type,
          value: totals.appliedCoupon.value,
          minSubtotal: totals.appliedCoupon.minSubtotal,
          maxDiscount: totals.appliedCoupon.maxDiscount,
        }
      : null,
    shipping: toMinor(totals.deliveryFee),
    otherCharges,
    placeOfSupply,
  };
}

/**
 * The breakdown for a cart, ready to render.
 *
 * `placeOfSupply` is unknown until a billing address is entered, so the bag
 * falls back to the seller's own state. That means the bag shows the
 * intra-state split and checkout may switch it to IGST once an address is
 * given — which is correct behaviour, not drift: the grand total is identical
 * either way, because the rate is the same and only its labelling changes.
 */
export function breakdownForCart(
  lines: ResolvedCartLine[],
  totals: CartTotals,
  placeOfSupply?: string,
): BillingBreakdown {
  const state = placeOfSupply?.trim() || getTaxConfig().originState;
  return calculateBilling(billingInputFromCart(lines, totals, state)).breakdown;
}

/* --------------------------------------------------------------------- refunds */

/**
 * What a refund is worth.
 *
 * Refunding part of an order gives back the goods value *and* the tax that was
 * charged on it — the tax was collected on the customer's behalf and has to go
 * back with it. Shipping is returned only on a whole-order refund, and only if
 * configured: the courier was still paid for a delivery that happened.
 */
export function calculateRefundAmount({
  lineAmount,
  isFullOrder,
  shipping,
  placeOfSupply,
  category = null,
}: {
  lineAmount: Money;
  isFullOrder: boolean;
  shipping: Money;
  placeOfSupply: string;
  category?: string | null;
}): { goods: Money; tax: Money; shipping: Money; total: Money } {
  const config = getTaxConfig();
  const breakdown = calculateTax(lineAmount, placeOfSupply, category, config);

  const shippingBack =
    isFullOrder && getBillingConfig().refund.refundShipping ? shipping : 0;

  // On tax-inclusive pricing the tax is already inside `lineAmount`, so adding
  // it would refund it twice.
  const total = (config.pricesIncludeTax ? lineAmount : lineAmount + breakdown.totalTax) + shippingBack;

  return {
    goods: breakdown.taxableAmount,
    tax: breakdown.totalTax,
    shipping: shippingBack,
    total,
  };
}

/* --------------------------------------------------------------------- helpers */

/**
 * A placeholder HSN code per category.
 *
 * Real classification is a product attribute set by whoever lists it, and gets
 * a column on the products table. This keeps the invoice's HSN column honest
 * about being demo data rather than inventing a different code every render.
 */
const HSN_BY_CATEGORY: Record<string, string> = {
  women: "6204",
  men: "6203",
  kids: "6209",
  footwear: "6403",
  bags: "4202",
  jewellery: "7117",
  accessories: "6217",
  beauty: "3304",
  home: "6304",
  electronics: "8517",
  lifestyle: "9503",
};

export function hsnFor(category: string | null): string {
  return (category && HSN_BY_CATEGORY[category]) || "9999";
}

export { combinedRate };
