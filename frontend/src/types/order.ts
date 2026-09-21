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
}

/** What the checkout hands to `orderService.placeOrder`. */
export interface PlaceOrderInput {
  lines: ResolvedCartLine[];
  totals: CartTotals;
  address: Address;
  deliveryMethod: DeliveryMethod;
  paymentMethod: PaymentMethod;
  email: string;
}
