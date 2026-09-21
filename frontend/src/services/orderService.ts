import type {
  DeliveryMethod,
  Order,
  OrderLine,
  PaymentMethod,
  PlaceOrderInput,
} from "@/types";

import { STORAGE_KEYS, readJson, writeJson } from "@/lib/storage/local-storage";
import { deliveryEstimate } from "@/lib/utils/format";

/**
 * Orders.
 *
 * There is no payment gateway and no backend here: `placeOrder` builds a
 * realistic order record and keeps it in local storage so the account area has
 * something true to show. Everything a real implementation would need is
 * already in the signature, so the swap is confined to this file:
 *
 *   placeOrder  →  POST /orders
 *   getOrders   →  GET  /orders
 *   getOrder    →  GET  /orders/:orderNumber
 *
 * Nothing here should ever be mistaken for a real transaction — no card data
 * is collected, stored or transmitted anywhere.
 */

export const DELIVERY_METHODS: DeliveryMethod[] = [
  {
    id: "standard",
    name: "Standard delivery",
    description: "Free on orders above ₹999",
    fee: 79,
    estimate: "3–5 business days",
  },
  {
    id: "express",
    name: "Express delivery",
    description: "Dispatched today, priority courier",
    fee: 149,
    estimate: "1–2 business days",
  },
];

export const PAYMENT_METHODS: PaymentMethod[] = [
  { id: "upi", name: "UPI", description: "Pay using any UPI app" },
  { id: "card", name: "Credit / Debit card", description: "Visa, Mastercard, RuPay, Amex" },
  { id: "netbanking", name: "Net banking", description: "All major Indian banks" },
  { id: "cod", name: "Cash on delivery", description: "Pay the courier when it arrives" },
];

/** Six hex characters is short enough to read aloud on a support call. */
function generateOrderNumber(): string {
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .toUpperCase()
    .padStart(6, "0");
  return `DCZ-${random}`;
}

function readOrders(): Order[] {
  return readJson<Order[]>(STORAGE_KEYS.orders, []);
}

export async function placeOrder(input: PlaceOrderInput): Promise<Order> {
  const lines: OrderLine[] = input.lines.map((line) => ({
    productId: line.product.id,
    name: line.product.name,
    slug: line.product.slug,
    image: line.product.images[0] ?? "",
    brand: line.product.brand,
    size: line.size,
    color: line.color,
    quantity: line.quantity,
    unitPrice: line.product.price,
    lineTotal: line.lineTotal,
  }));

  const businessDays = input.deliveryMethod.id === "express" ? 2 : 5;

  const order: Order = {
    id: `ord_${Date.now()}`,
    orderNumber: generateOrderNumber(),
    placedAt: new Date().toISOString(),
    status: "confirmed",
    lines,
    address: input.address,
    deliveryMethod: input.deliveryMethod,
    paymentMethod: input.paymentMethod,
    totals: input.totals,
    expectedDelivery: deliveryEstimate(businessDays),
  };

  // Newest first, so the account page needs no sorting.
  writeJson(STORAGE_KEYS.orders, [order, ...readOrders()]);
  return order;
}

export async function getOrders(): Promise<Order[]> {
  return readOrders();
}

export async function getOrder(orderNumber: string): Promise<Order | null> {
  return readOrders().find((order) => order.orderNumber === orderNumber) ?? null;
}

export function getDeliveryMethod(id: string): DeliveryMethod {
  return DELIVERY_METHODS.find((method) => method.id === id) ?? DELIVERY_METHODS[0]!;
}

export function getPaymentMethod(id: string): PaymentMethod {
  return PAYMENT_METHODS.find((method) => method.id === id) ?? PAYMENT_METHODS[0]!;
}
