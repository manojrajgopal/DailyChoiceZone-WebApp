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

export type DeliveryMethodId = "standard" | "express";

export interface DeliveryMethod {
  id: DeliveryMethodId;
  name: string;
  description: string;
  fee: number;
  /** Human-readable estimate, e.g. "3-5 business days". */
  estimate: string;
}

export type PaymentMethodId = "card" | "upi" | "netbanking" | "cod";

export interface PaymentMethod {
  id: PaymentMethodId;
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
