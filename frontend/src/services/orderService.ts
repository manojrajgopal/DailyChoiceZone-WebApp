import type {
  DeliveryMethod,
  Order,
  PaymentMethod,
  PlaceOrderInput,
} from "@/types";

import { apiGet, apiGetOrNull, apiPost } from "@/services/api/client";

/**
 * Orders.
 *
 * Placing one is a single call. The server creates the order, takes the stock,
 * records the payment and issues the invoice **in one transaction** — which is
 * exactly what a browser cannot do, because a failure halfway through leaves
 * an order nobody was charged for or stock consumed by an order that does not
 * exist.
 *
 * Nothing about money is sent. Prices, discounts, tax and the total are all
 * recalculated server-side from the cart and the catalogue: a client that
 * could name its own total would eventually name a smaller one.
 */

const AUTH = { auth: "customer" } as const;

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

/** What the API returns for an order. */
interface ApiOrder {
  id: string;
  orderNumber: string;
  placedAt: string;
  status: Order["status"];
  paymentStatus: string;
  paymentMethod: string;
  deliveryMethod: string;
  expectedDelivery: string;
  items: {
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
  }[];
  totals: {
    itemCount: number;
    subtotal: number;
    catalogueSavings: number;
    couponDiscount: number;
    deliveryFee: number;
    taxAmount: number;
    total: number;
  };
  shippingAddress: {
    fullName: string;
    phone: string;
    line1: string;
    line2: string;
    city: string;
    state: string;
    pincode: string;
    country: string;
  };
  couponCode: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
}

export interface PlacedOrder {
  order: Order;
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  paymentStatus: string;
}

function toOrder(payload: ApiOrder): Order {
  const delivery = getDeliveryMethod(payload.deliveryMethod);
  const payment = getPaymentMethod(payload.paymentMethod);

  return {
    id: payload.id,
    orderNumber: payload.orderNumber,
    placedAt: payload.placedAt,
    status: payload.status,
    lines: payload.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      slug: item.slug,
      image: item.image,
      brand: item.brand,
      size: item.size,
      color: item.color,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
    })),
    address: {
      id: "",
      fullName: payload.shippingAddress.fullName,
      phone: payload.shippingAddress.phone,
      line1: payload.shippingAddress.line1,
      line2: payload.shippingAddress.line2,
      city: payload.shippingAddress.city,
      state: payload.shippingAddress.state,
      pincode: payload.shippingAddress.pincode,
      type: "home",
      isDefault: false,
    },
    deliveryMethod: { ...delivery, fee: payload.totals.deliveryFee },
    paymentMethod: payment,
    totals: {
      itemCount: payload.totals.itemCount,
      subtotal: payload.totals.subtotal,
      catalogueSavings: payload.totals.catalogueSavings,
      couponDiscount: payload.totals.couponDiscount,
      deliveryFee: payload.totals.deliveryFee,
      total: payload.totals.total,
      freeDeliveryShortfall: 0,
      appliedCoupon: null,
    },
    expectedDelivery: payload.expectedDelivery,
    invoiceId: payload.invoiceId,
    invoiceNumber: payload.invoiceNumber,
  };
}

/**
 * Place the order.
 *
 * `PlaceOrderInput` still carries the lines and totals the checkout was
 * showing, and they are deliberately **not** sent: the server prices the cart
 * it holds. They stay in the signature because the checkout builds them for
 * display, and removing them would mean changing every caller for no gain.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<Order> {
  const payload = await apiPost<{
    order: ApiOrder;
    invoiceId: string;
    invoiceNumber: string;
    paymentId: string;
    paymentStatus: string;
  }>(
    "/orders",
    {
      shippingAddress: {
        fullName: input.address.fullName,
        phone: input.address.phone,
        line1: input.address.line1,
        line2: input.address.line2,
        city: input.address.city,
        state: input.address.state,
        pincode: input.address.pincode,
        country: "India",
        email: input.email,
      },
      billingAddress: input.billingAddress ?? null,
      deliveryMethod: input.deliveryMethod.id,
      paymentMethod: input.paymentMethod.id,
      couponCode: input.totals.appliedCoupon?.code ?? null,
      email: input.email,
      saveAddress: true,
    },
    AUTH,
  );

  return toOrder(payload.order);
}

export async function getOrders(): Promise<Order[]> {
  try {
    const orders = await apiGet<ApiOrder[]>("/orders", AUTH);
    return orders.map(toOrder);
  } catch {
    return [];
  }
}

export async function getOrder(identifier: string): Promise<Order | null> {
  const payload = await apiGetOrNull<ApiOrder>(
    `/orders/${encodeURIComponent(identifier)}`,
    AUTH,
  );
  return payload ? toOrder(payload) : null;
}

/**
 * Cancel an order.
 *
 * Refused by the server once the parcel has been dispatched — at that point it
 * is a return, which is a different process.
 */
export async function cancelOrder(identifier: string, reason = ""): Promise<Order> {
  const payload = await apiPost<ApiOrder>(
    `/orders/${encodeURIComponent(identifier)}/cancel`,
    { reason },
    AUTH,
  );
  return toOrder(payload);
}

export function getDeliveryMethod(id: string): DeliveryMethod {
  return DELIVERY_METHODS.find((method) => method.id === id) ?? DELIVERY_METHODS[0]!;
}

export function getPaymentMethod(id: string): PaymentMethod {
  return PAYMENT_METHODS.find((method) => method.id === id) ?? PAYMENT_METHODS[0]!;
}
