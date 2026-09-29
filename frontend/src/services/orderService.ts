import type {
  DeliveryMethod,
  GatewayHandoff,
  Order,
  PaymentMethod,
  PlaceOrderInput,
} from "@/types";

import { apiGet, apiGetOrNull, apiPost } from "@/services/api/client";
import { paymentMethodLabel } from "@/services/billing/paymentService";

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

/**
 * The methods on offer, as the store configured them.
 *
 * Held as module state rather than fetched per lookup, because `toOrder` maps
 * a payload synchronously and the review page reads a method while rendering.
 * `siteService` fills both in when it reads the site content, which every page
 * does once — the same arrangement `formatMoney` uses for the currency.
 */
let deliveryMethods: DeliveryMethod[] = [];
let paymentMethods: PaymentMethod[] = [];

export function setDeliveryMethods(methods: DeliveryMethod[]): void {
  deliveryMethods = methods;
}

export function setPaymentMethods(methods: PaymentMethod[]): void {
  paymentMethods = methods;
}

/**
 * Wait for the method lists before mapping an order.
 *
 * A page that reads an order straight away — the order confirmation, opened
 * fresh after checkout — used to map it before the site content arrived, and
 * showed "Paid by cod" and "standard ·" instead of the methods' names.
 * Imported lazily: `siteService` imports this module to fill the lists.
 */
async function methodsLoaded(): Promise<void> {
  if (paymentMethods.length && deliveryMethods.length) return;
  try {
    const { getSiteContent } = await import("./siteService");
    await getSiteContent();
  } catch {
    /* the ids still read, just less nicely */
  }
}

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
  /**
   * How to pay for it, or null when there is nothing to pay.
   *
   * With a real gateway, placing an order is only half of checkout: the order
   * exists and the invoice is issued before any money moves. Null means cash
   * on delivery, or a provider that settled it synchronously.
   */
  gateway: GatewayHandoff | null;
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
    paymentStatus: payload.paymentStatus,
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
/**
 * Place the order, and find out whether it still has to be paid for.
 *
 * Returns the gateway handoff alongside the order rather than a bare `Order`,
 * because with a real gateway placing an order is only half of checkout: the
 * order exists, the invoice is issued, and the money has not moved yet. The
 * caller opens the payment sheet with what comes back.
 *
 * `gateway: null` means there is nothing to pay — cash on delivery, or a
 * provider that settled it synchronously.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<PlacedOrder> {
  const [payload] = await Promise.all([
    apiPost<{
      order: ApiOrder;
      invoiceId: string;
      invoiceNumber: string;
      paymentId: string;
      paymentStatus: string;
      gateway: GatewayHandoff | null;
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
    ),
    methodsLoaded(),
  ]);

  return {
    order: toOrder(payload.order),
    paymentId: payload.paymentId,
    paymentStatus: payload.paymentStatus,
    invoiceId: payload.invoiceId,
    invoiceNumber: payload.invoiceNumber,
    gateway: payload.gateway,
  };
}

export async function getOrders(): Promise<Order[]> {
  try {
    const [orders] = await Promise.all([
      apiGet<ApiOrder[]>("/orders", AUTH),
      methodsLoaded(),
    ]);
    return orders.map(toOrder);
  } catch {
    return [];
  }
}

export async function getOrder(identifier: string): Promise<Order | null> {
  const [payload] = await Promise.all([
    apiGetOrNull<ApiOrder>(`/orders/${encodeURIComponent(identifier)}`, AUTH),
    methodsLoaded(),
  ]);
  return payload ? toOrder(payload) : null;
}

/**
 * Cancel an order.
 *
 * Refused by the server once the parcel has been dispatched — at that point it
 * is a return, which is a different process.
 */
export async function cancelOrder(
  identifier: string,
  reason = "",
): Promise<Order> {
  const [payload] = await Promise.all([
    apiPost<ApiOrder>(
      `/orders/${encodeURIComponent(identifier)}/cancel`,
      { reason },
      AUTH,
    ),
    methodsLoaded(),
  ]);
  return toOrder(payload);
}

/**
 * One method by id.
 *
 * Falls back to a record carrying the id itself rather than to the first in
 * the list: an order placed with a method the store has since withdrawn should
 * read "netbanking", not silently become "UPI".
 */
export function getDeliveryMethod(id: string): DeliveryMethod {
  return (
    deliveryMethods.find((method) => method.id === id) ?? {
      id,
      name: id,
      description: "",
      fee: 0,
      estimate: "",
    }
  );
}

export function getPaymentMethod(id: string): PaymentMethod {
  return (
    paymentMethods.find((method) => method.id === id) ?? {
      id,
      name: paymentMethodLabel(id),
      description: "",
    }
  );
}
