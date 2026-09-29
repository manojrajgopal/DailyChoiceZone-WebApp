import type { BillingAddress } from "./billing";
import type { CartTotals, ResolvedCartLine } from "./cart";

export interface Address {
  id: string;
  fullName: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
  /** Shown as a chip on the address card. */
  type: "home" | "work";
  isDefault: boolean;
}

/**
 * The delivery methods the store ships with.
 *
 * A hint, not a closed set: which methods exist is configuration an
 * administrator edits, so `DeliveryMethod.id` is a plain string and this union
 * documents what is there out of the box.
 */
export type DeliveryMethodId = "standard" | "express";

export interface DeliveryMethod {
  id: string;
  name: string;
  description: string;
  fee: number;
  /** Human-readable estimate, e.g. "3-5 business days". */
  estimate: string;
}

/** The payment methods the store ships with. See `DeliveryMethodId`. */
export type PaymentMethodId = "card" | "upi" | "netbanking" | "cod";

export interface PaymentMethod {
  id: string;
  name: string;
  description: string;
}

export type OrderStatus =
  | "placed"
  | "confirmed"
  | "shipped"
  | "out-for-delivery"
  | "delivered"
  | "cancelled";

export interface OrderLine {
  productId: string;
  name: string;
  slug: string;
  image: string;
  brand: string;
  size: string | null;
  color: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Order {
  id: string;
  /** The customer-facing number, e.g. "DCZ-4F8210". */
  orderNumber: string;
  placedAt: string;
  status: OrderStatus;
  lines: OrderLine[];
  address: Address;
  deliveryMethod: DeliveryMethod;
  paymentMethod: PaymentMethod;
  totals: CartTotals;
  /** Delivery estimate captured at checkout time. */
  expectedDelivery: string;
  /**
   * The billing records raised for this order.
   *
   * Ids, not embedded objects: the invoice is its own record with its own
   * lifecycle, and copying it here would mean two versions of the same
   * document disagreeing the first time one of them is edited.
   */
  invoiceId?: string | null;
  paymentId?: string | null;
  /** Denormalised for the order list, which shows it without a second read. */
  invoiceNumber?: string | null;
  /**
   * Where the money stands: pending | paid | failed | cod-pending | refunded.
   *
   * Separate from `status`, because an order's progress and its payment are
   * two different things: a prepaid order sits at `pending` until the gateway
   * settles it, and a cash-on-delivery order is confirmed and shipped while
   * still unpaid.
   */
  paymentStatus: string;
}

/**
 * What the checkout hands to `orderService.placeOrder`.
 *
 * `lines` and `totals` are what the page was *showing*. They are not sent:
 * the server prices the cart it holds, because a client that could name its
 * own total would eventually name a smaller one. They stay here because the
 * checkout builds them to render, and the guard below reads them.
 */
export interface PlaceOrderInput {
  lines: ResolvedCartLine[];
  totals: CartTotals;
  address: Address;
  /** Only when it differs from the delivery address. Decides the tax treatment. */
  billingAddress?: BillingAddress | null;
  deliveryMethod: DeliveryMethod;
  paymentMethod: PaymentMethod;
  email: string;
}

/* --------------------------------------------------------- payment gateway */

/**
 * What the server hands the browser so it can open the payment sheet.
 *
 * `null` from the API means no handoff is needed: cash on delivery, or a
 * provider that settled the payment synchronously. The caller goes straight to
 * the confirmation page.
 *
 * Everything in here is publishable or already the shopper's own. There is no
 * secret and no signature — the only signature in the flow is the one the
 * gateway produces and the server checks. See `gateway_handoff` on the API
 * side.
 */
export interface GatewayHandoff {
  provider: "razorpay";
  /** The publishable key id. */
  keyId: string;
  /** The gateway's own order reference. */
  orderReference: string;
  /** Our payment record, so the verify call knows what it is settling. */
  paymentId: string;
  /** Minor units. What the sheet displays; the gateway charges its own figure. */
  amount: number;
  currency: string;
  name: string;
  email: string;
  phone: string;
  description: string;
  /**
   * The store's name, as the payment sheet shows it.
   *
   * From the billing document, so it reads as the store the shopper is buying
   * from rather than as whatever the gateway account is called.
   */
  merchantName: string;
}
