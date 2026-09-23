/**
 * The billing domain.
 *
 * Four records, related by id and never by copy: an **order** is what was
 * bought, an **invoice** is the demand for payment, a **payment** is money
 * moving, and a **refund** (with an optional **credit note**) is money moving
 * back. A real schema would be `orders`, `invoices`, `invoice_items`,
 * `payments`, `refunds`, `credit_notes`, and these shapes are written to map
 * onto it row for row.
 *
 * Every amount is `Money` — an integer in the currency's minor unit. See
 * `lib/money.ts` for why.
 */

/** An integer number of minor units (paise for INR). Never a float. */
export type Money = number;

export interface CurrencyConfig {
  code: string;
  symbol: string;
  locale: string;
  /** Minor units per major unit, as a power of ten. 2 for INR. */
  decimals: number;
}

/* ----------------------------------------------------------------------- tax */

export type TaxType = "GST" | "NONE";

/**
 * How tax is worked out.
 *
 * `originState` is where the business is registered. Indian GST splits into
 * CGST + SGST when the place of supply matches it and becomes a single IGST
 * when it does not, which is the only rule this models.
 *
 * **This is a configurable representation of GST, not a compliance
 * implementation.** Real tax treatment depends on HSN codes, exemptions,
 * composition schemes, reverse charge, place-of-supply rules and thresholds
 * that belong in a backend with an accountant behind it.
 */
export interface TaxConfig {
  enabled: boolean;
  taxType: TaxType;
  /** Whether catalogue prices already contain the tax. */
  pricesIncludeTax: boolean;
  /** The seller's state, for the intra/inter-state decision. */
  originState: string;
  /** Registration number shown on invoices. Display only. */
  gstin: string;
  rates: {
    cgst: number;
    sgst: number;
    igst: number;
  };
  /** Per-category overrides, by category slug. Falls back to `rates`. */
  categoryRates?: Record<string, { cgst: number; sgst: number; igst: number }>;
}

export type TaxMode = "intra-state" | "inter-state" | "none";

export interface TaxBreakdown {
  mode: TaxMode;
  /** The value tax was charged on, exclusive of tax. */
  taxableAmount: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  totalTax: Money;
  /** The combined rate applied, for the "Tax (18%)" label. */
  ratePercent: number;
}

/* ------------------------------------------------------------------ breakdown */

/**
 * One money picture, used everywhere.
 *
 * The bag, every checkout step, the order record, the invoice, the admin order
 * page and the reports all render this same shape, produced by one function in
 * `billingService`. Components that each did their own arithmetic is how a
 * checkout ends up quoting two different totals.
 *
 * Components are preserved rather than collapsed into a total: an invoice has
 * to be able to show what was charged and why, and a refund has to be able to
 * work backwards through it.
 */
export interface BillingBreakdown {
  currency: string;
  itemCount: number;
  /** Line values at selling price, before order-level discounts. */
  subtotal: Money;
  /** Savings already reflected in selling prices, against list price. */
  productDiscount: Money;
  couponDiscount: Money;
  couponCode: string | null;
  shipping: Money;
  /** Anything the catalogue does not price — handling, gift wrap, COD fee. */
  otherCharges: Money;
  taxableAmount: Money;
  tax: TaxBreakdown;
  grandTotal: Money;
  /** True when `subtotal` already contains `tax.totalTax`. */
  pricesIncludeTax: boolean;
}

/* --------------------------------------------------------------- addresses */

/**
 * A billing address.
 *
 * Wider than the shipping `Address`: an invoice needs a country and a
 * contactable email, and the place of supply is read from `state`.
 */
export interface BillingAddress {
  fullName: string;
  phone: string;
  email: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/* ----------------------------------------------------------------- invoices */

export type InvoiceStatus = "draft" | "issued" | "paid" | "overdue" | "cancelled";

export interface InvoiceLine {
  productId: string;
  name: string;
  sku: string;
  /** Harmonised System code. Placeholder data — see `TaxConfig`. */
  hsn: string;
  size: string | null;
  color: string | null;
  quantity: number;
  /** Selling price per unit, as charged. */
  unitPrice: Money;
  /** `unitPrice × quantity`. */
  lineSubtotal: Money;
  /** This line's share of order-level discounts. */
  discount: Money;
  taxableAmount: Money;
  taxRatePercent: number;
  cgst: Money;
  sgst: Money;
  igst: Money;
  tax: Money;
  /** What this line contributes to the grand total. */
  lineTotal: Money;
}

export interface Invoice {
  id: string;
  /** Human-facing, sequential, e.g. "DCZ-INV-2026-000001". */
  invoiceNumber: string;
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  status: InvoiceStatus;
  issuedAt: string;
  dueAt: string;
  billingAddress: BillingAddress;
  shippingAddress: BillingAddress;
  /** The state tax was charged against. */
  placeOfSupply: string;
  lines: InvoiceLine[];
  breakdown: BillingBreakdown;
  paymentId: string | null;
  paymentMethod: PaymentMethodKey;
  paymentStatus: BillingPaymentStatus;
  /** Settled so far. Below `grandTotal` on a part-paid invoice. */
  amountPaid: Money;
  amountRefunded: Money;
  notes: string;
  terms: string;
}

/* ----------------------------------------------------------------- payments */

export type PaymentMethodKey =
  | "upi"
  | "card"
  | "debit-card"
  | "netbanking"
  | "cod"
  | "wallet";

export type BillingPaymentStatus =
  | "pending"
  | "authorized"
  | "paid"
  | "failed"
  | "refunded"
  | "partially-refunded";

export interface PaymentEvent {
  status: "initiated" | "processing" | "authorized" | "succeeded" | "failed" | "refunded";
  at: string;
  note: string;
}

export interface Payment {
  id: string;
  /** The reference a customer quotes to support, e.g. "TXN2026090412345". */
  transactionId: string;
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  amount: Money;
  refundedAmount: Money;
  method: PaymentMethodKey;
  status: BillingPaymentStatus;
  /** Which integration handled it. "mock" until a real one is wired in. */
  provider: string;
  createdAt: string;
  capturedAt: string | null;
  /** Append-only. Drives the transaction timeline. */
  timeline: PaymentEvent[];
  /**
   * Safe, non-identifying remnants only — a card's last four digits, a masked
   * UPI handle. Never a full number, never a CVV, never a credential.
   */
  instrumentHint: string;
}

/* ------------------------------------------------------------------ refunds */

export type RefundStatus = "requested" | "processing" | "completed" | "rejected";

export interface RefundLine {
  productId: string;
  name: string;
  quantity: number;
  amount: Money;
}

export interface Refund {
  id: string;
  refundNumber: string;
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  customerId: string;
  customerName: string;
  amount: Money;
  reason: string;
  status: RefundStatus;
  requestedAt: string;
  processedAt: string | null;
  /** Empty for a whole-order refund; populated for a per-item one. */
  lines: RefundLine[];
  creditNoteId: string | null;
  /** Who initiated it — an admin id, or "customer". */
  initiatedBy: string;
}

/* ------------------------------------------------------------- credit notes */

export type CreditNoteStatus = "draft" | "issued" | "cancelled";

export interface CreditNote {
  id: string;
  creditNoteNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  refundId: string | null;
  reason: string;
  /** Value before tax. */
  amount: Money;
  tax: Money;
  total: Money;
  issuedAt: string;
  status: CreditNoteStatus;
}

/* -------------------------------------------------------------- configuration */

export interface BillingConfig {
  business: {
    legalName: string;
    storeName: string;
    email: string;
    phone: string;
    website: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
  currency: CurrencyConfig;
  invoice: {
    prefix: string;
    /** The first number a fresh sequence issues. */
    startNumber: number;
    /** Zero-padded width of the numeric part. */
    padding: number;
    /** Days from issue to due. */
    dueDays: number;
    footer: string;
    paymentTerms: string;
    notes: string;
  };
  creditNote: {
    prefix: string;
    startNumber: number;
    padding: number;
  };
  refund: {
    /** Days after delivery a refund can still be raised. Advisory here. */
    windowDays: number;
    /** Whether shipping is given back on a whole-order refund. */
    refundShipping: boolean;
    reasons: string[];
  };
  payment: {
    /** Methods offered at checkout, in order. */
    enabledMethods: PaymentMethodKey[];
    /** Extra charge for cash on delivery, in minor units. */
    codFee: Money;
  };
}

/* ----------------------------------------------------------------- reporting */

export interface BillingStats {
  revenue: Money;
  paid: Money;
  pending: Money;
  refunded: Money;
  taxCollected: Money;
  shippingRevenue: Money;
  discountsGiven: Money;
  invoiceCount: number;
  paymentCount: number;
  refundCount: number;
  creditNoteCount: number;
  /** Grand total minus refunds — what the business actually kept. */
  netSales: Money;
}

/** One row of the tax report: how much was collected at each rate. */
export interface TaxReportRow {
  ratePercent: number;
  taxableAmount: Money;
  cgst: Money;
  sgst: Money;
  igst: Money;
  totalTax: Money;
  invoiceCount: number;
}

/** What `placeOrder` needs to bill for, beyond the cart itself. */
export interface BillingContext {
  billingAddress: BillingAddress;
  shippingAddress: BillingAddress;
  paymentMethod: PaymentMethodKey;
  shipping: Money;
  otherCharges: Money;
}
