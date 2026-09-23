import type {
  BillingAddress,
  CartTotals,
  DeliveryMethod,
  Invoice,
  Order,
  Payment,
  PaymentMethodKey,
  PlaceOrderInput,
  ResolvedCartLine,
} from "@/types";

import { calculateBilling, billingInputFromCart, getBillingConfig } from "./billingService";
import { createInvoice } from "./invoiceService";
import { createPayment, updatePayment } from "./paymentService";

/**
 * Turning a checkout into a billed order.
 *
 * The sequence the whole system depends on, in one place:
 *
 *   place the order  →  calculate the billing  →  take the payment
 *                    →  raise the invoice      →  confirm
 *
 * The order comes first because the invoice has to reference it, and the
 * payment comes before the invoice because the invoice records how it was
 * settled. Spread across four components this ordering is something everyone
 * has to remember; here it is something nobody can get wrong.
 *
 * Future: one `POST /orders` does all of this in a transaction, and this
 * function becomes the call that awaits it. Doing it in four steps on the
 * client means a failure halfway leaves an order without an invoice — which is
 * precisely why a real implementation does not.
 */

/** The checkout's method ids, widened to the billing domain's. */
export function toBillingMethod(id: string): PaymentMethodKey {
  switch (id) {
    case "card":
      return "card";
    case "upi":
      return "upi";
    case "netbanking":
      return "netbanking";
    case "cod":
      return "cod";
    case "wallet":
      return "wallet";
    case "debit-card":
      return "debit-card";
    default:
      return "card";
  }
}

export interface BilledOrder {
  order: Order;
  invoice: Invoice;
  payment: Payment;
}

export interface PlaceBilledOrderInput {
  /** Runs the existing order creation. Kept injected so this file owns no storage. */
  placeOrder: (input: PlaceOrderInput) => Promise<Order>;
  /** Writes the billing ids back onto the order once they exist. */
  attachBilling: (
    orderId: string,
    billing: { invoiceId: string; invoiceNumber: string; paymentId: string },
  ) => Promise<void>;
  lines: ResolvedCartLine[];
  totals: CartTotals;
  billingAddress: BillingAddress;
  shippingAddress: BillingAddress;
  orderInput: PlaceOrderInput;
  paymentMethodId: string;
  deliveryMethod: DeliveryMethod;
  /**
   * Who is being billed.
   *
   * The signed-in customer's id where there is one. A guest checkout has no
   * customer record yet, so the order id stands in — a real backend creates
   * the customer row at this point and returns its id instead.
   */
  customerId: string;
}

export async function placeBilledOrder(input: PlaceBilledOrderInput): Promise<BilledOrder> {
  const config = getBillingConfig();
  const method = toBillingMethod(input.paymentMethodId);

  // 1. The order. Everything below references it.
  const order = await input.placeOrder(input.orderInput);

  // 2. The money, worked out once, against the billing address's state.
  const { breakdown, lines } = calculateBilling(
    billingInputFromCart(input.lines, input.totals, input.billingAddress.state),
  );

  // 3. The payment. Its id is fixed here so the invoice can carry it.
  const paymentId = `pay_${order.id.replace(/^ord_/, "")}`;
  const payment = await createPayment({
    id: paymentId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    invoiceId: "", // filled in below, once the invoice has a number
    invoiceNumber: "",
    customerId: input.customerId,
    customerName: input.billingAddress.fullName,
    customerEmail: input.billingAddress.email,
    amount: breakdown.grandTotal,
    currency: config.currency.code,
    method,
  });

  // 4. The invoice.
  const invoice = await createInvoice({
    orderId: order.id,
    orderNumber: order.orderNumber,
    customerId: input.customerId,
    customerName: input.billingAddress.fullName,
    customerEmail: input.billingAddress.email,
    billingAddress: input.billingAddress,
    shippingAddress: input.shippingAddress,
    lines,
    breakdown,
    paymentMethod: method,
    paymentStatus: payment.status,
    paymentId: payment.id,
  });

  // The payment was written before the invoice existed; close the loop so each
  // record can reach the other, which is what the admin pages navigate by.
  const linkedPayment = await updatePayment({
    ...payment,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
  });

  // 5. Point the order at both, so the account page and the portal can
  //    navigate from an order to its billing without a search.
  await input.attachBilling(order.id, {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    paymentId: linkedPayment.id,
  });

  return {
    order: { ...order, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, paymentId: linkedPayment.id },
    invoice,
    payment: linkedPayment,
  };
}

/**
 * Build a billing address from the checkout's shipping address.
 *
 * Used when "billing address same as shipping" is left ticked, which is the
 * overwhelming majority of orders.
 */
export function billingAddressFromShipping(
  address: { fullName: string; phone: string; line1: string; line2: string; city: string; state: string; pincode: string },
  email: string,
  country = "India",
): BillingAddress {
  return {
    fullName: address.fullName,
    phone: address.phone,
    email,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.pincode,
    country,
  };
}
