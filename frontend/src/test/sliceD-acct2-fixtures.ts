/**
 * Fixtures for slice D / acct2 (orders, reorder, returns, invoices).
 *
 *   signInCustomer()                 // token + store session + /auth/me answered
 *   apiOrder({ status: "shipped" })  // an order as GET /orders sends it
 *   reorderLine({ quantity: 0 })     // a line of GET /orders/:id/reorder
 *   eligibility(), returnRequest()   // GET /orders/:id/returns
 *   invoice(), billingConfig(), taxConfig()
 */
import type { BillingConfig, Invoice, TaxConfig } from "@/types";
import type { ReorderLine, Reorderable } from "@/services/messagingService";
import type { ReturnEligibility, ReturnEligibleItem, ReturnRequest } from "@/types/returns";

import { useSessionStore } from "@/store/sessionStore";

import { api } from "./api";
import { signIn } from "./render";

export const CUSTOMER = {
  id: "C1",
  email: "meera@example.com",
  firstName: "Meera",
  lastName: "Iyer",
  name: "Meera Iyer",
  phone: "9876543210",
  status: "active",
  joinedAt: "2025-03-01T10:00:00",
  emailVerified: true,
};

/** Sign a customer in the way the account pages find them. */
export function signInCustomer() {
  signIn("customer", "cust-token");
  useSessionStore.setState({
    session: {
      token: "cust-token",
      user: {
        id: CUSTOMER.id,
        firstName: CUSTOMER.firstName,
        lastName: CUSTOMER.lastName,
        email: CUSTOMER.email,
        phone: CUSTOMER.phone,
        memberSince: CUSTOMER.joinedAt,
        emailVerified: true,
      },
    },
  });
  api.get("/auth/me", CUSTOMER);
}

type ApiItem = {
  id?: number;
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
  bundleName?: string;
  bundleQuantity?: number;
  regularUnitPrice?: number | null;
  flashSaleId?: number | null;
};

export function apiItem(overrides: Partial<ApiItem> = {}): ApiItem {
  return {
    id: 11,
    productId: "P1",
    name: "Linen Shirt",
    slug: "linen-shirt",
    image: "/img/shirt.jpg",
    brand: "Weave & Co",
    size: "M",
    color: "Blue",
    quantity: 1,
    unitPrice: 1499,
    lineTotal: 1499,
    ...overrides,
  };
}

export interface ApiOrderFixture {
  id: string;
  orderNumber: string;
  placedAt: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  deliveryMethod: string;
  expectedDelivery: string;
  items: ApiItem[];
  totals: {
    itemCount: number;
    subtotal: number;
    catalogueSavings: number;
    couponDiscount: number;
    deliveryFee: number;
    taxAmount: number;
    total: number;
    giftCardAmount?: number;
    storeCreditAmount?: number;
    pointsAmount?: number;
    pointsRedeemed?: number;
    amountDue?: number;
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
  paymentId?: string | null;
}

export function apiOrder(
  overrides: Partial<Omit<ApiOrderFixture, "totals">> & { totals?: Partial<ApiOrderFixture["totals"]> } = {},
): ApiOrderFixture {
  const { totals, ...rest } = overrides;
  return {
    id: "O1",
    orderNumber: "DCZ-1001",
    placedAt: "2026-09-20T06:30:00",
    status: "shipped",
    paymentStatus: "paid",
    paymentMethod: "upi",
    deliveryMethod: "standard",
    expectedDelivery: "Fri, 25 Sep",
    items: [apiItem()],
    shippingAddress: {
      fullName: "Meera Iyer",
      phone: "9876543210",
      line1: "12 MG Road",
      line2: "Flat 4B",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      country: "India",
    },
    couponCode: null,
    invoiceId: "INV1",
    invoiceNumber: "DCZ-INV-2026-000001",
    ...rest,
    totals: {
      itemCount: 1,
      subtotal: 1499,
      catalogueSavings: 0,
      couponDiscount: 0,
      deliveryFee: 0,
      taxAmount: 0,
      total: 1499,
      ...totals,
    },
  };
}

/** The site content the order mapper waits for, with named methods. */
export function siteContentWithMethods() {
  return {
    deliveryMethods: [{ id: "standard", name: "Standard delivery", description: "", fee: 0, estimate: "3–5 days" }],
    paymentMethods: [{ id: "upi", name: "UPI", label: "UPI", description: "" }],
  };
}

/* ------------------------------------------------------------------ reorder */

export function reorderLine(overrides: Partial<ReorderLine> = {}): ReorderLine {
  return {
    key: "item:11",
    kind: "item",
    orderItemId: 11,
    productId: "P1",
    name: "Linen Shirt",
    image: "/img/shirt.jpg",
    size: "M",
    color: "Blue",
    orderedQuantity: 1,
    orderedUnitPrice: 1499,
    currentPrice: 1499,
    quantity: 1,
    status: "available",
    reason: null,
    ...overrides,
  };
}

export function reorderable(items: ReorderLine[], overrides: Partial<Reorderable> = {}): Reorderable {
  return {
    orderId: "O1",
    orderNumber: "DCZ-1001",
    placedAt: "2026-09-20T06:30:00",
    items,
    addable: items.filter((i) => i.quantity > 0).length,
    unavailable: items.filter((i) => i.quantity === 0).length,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ returns */

export function eligibleItem(overrides: Partial<ReturnEligibleItem> = {}): ReturnEligibleItem {
  return {
    orderItemId: 11,
    productId: "P1",
    name: "Linen Shirt",
    image: "/img/shirt.jpg",
    size: "M",
    color: "Blue",
    quantity: 1,
    available: 1,
    returnable: true,
    replaceable: true,
    isReturnable: true,
    isReplaceable: true,
    ...overrides,
  };
}

export function eligibility(overrides: Partial<ReturnEligibility> = {}): ReturnEligibility {
  return {
    eligible: true,
    reason: "",
    windowDays: 7,
    windowEndsAt: "2026-10-05",
    reasons: { return: ["Too small", "Changed my mind"], replacement: ["Damaged", "Wrong item"] },
    items: [eligibleItem()],
    ...overrides,
  };
}

export function returnRequest(overrides: Partial<ReturnRequest> = {}): ReturnRequest {
  return {
    id: "RET-1",
    orderId: "O1",
    orderNumber: "DCZ-1001",
    kind: "return",
    status: "approved",
    reason: "Too small",
    comment: "",
    resolutionNote: "",
    amount: 149900,
    refundId: null,
    createdAt: "2026-09-27",
    updatedAt: "2026-09-27",
    canCancel: true,
    items: [{ orderItemId: 11, productId: "P1", name: "Linen Shirt", image: "/img/shirt.jpg", size: "M", color: "Blue", quantity: 1, amount: 149900 }],
    timeline: [],
    ...overrides,
  };
}

/* ----------------------------------------------------------------- invoices */

const ADDRESS = {
  fullName: "Meera Iyer",
  phone: "9876543210",
  email: "meera@example.com",
  line1: "12 MG Road",
  line2: "",
  city: "Bengaluru",
  state: "Karnataka",
  postalCode: "560001",
  country: "India",
};

export function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "INV1",
    invoiceNumber: "DCZ-INV-2026-000001",
    orderId: "O1",
    orderNumber: "DCZ-1001",
    customerId: "C1",
    customerName: "Meera Iyer",
    customerEmail: "meera@example.com",
    status: "paid",
    issuedAt: "2026-09-20",
    dueAt: "2026-09-27",
    billingAddress: ADDRESS,
    shippingAddress: ADDRESS,
    placeOfSupply: "Karnataka",
    lines: [
      {
        productId: "P1",
        name: "Linen Shirt",
        sku: "SKU-1",
        hsn: "6205",
        size: "M",
        color: "Blue",
        quantity: 1,
        unitPrice: 149900,
        lineSubtotal: 149900,
        discount: 0,
        taxableAmount: 133839,
        taxRatePercent: 12,
        cgst: 8030,
        sgst: 8031,
        igst: 0,
        tax: 16061,
        lineTotal: 149900,
      },
    ],
    breakdown: {
      currency: "INR",
      itemCount: 1,
      subtotal: 149900,
      productDiscount: 0,
      couponDiscount: 0,
      couponCode: null,
      shipping: 0,
      otherCharges: 0,
      taxableAmount: 133839,
      tax: { mode: "intra-state", taxableAmount: 133839, cgst: 8030, sgst: 8031, igst: 0, totalTax: 16061, ratePercent: 12 },
      grandTotal: 149900,
      pricesIncludeTax: true,
    },
    paymentId: "PAY1",
    paymentMethod: "upi",
    paymentStatus: "paid",
    amountPaid: 149900,
    amountRefunded: 0,
    notes: "Thank you for shopping.",
    terms: "Payment due on receipt.",
    ...overrides,
  };
}

export function billingConfig(): BillingConfig {
  return {
    business: {
      legalName: "Daily Choice Zone Pvt Ltd",
      storeName: "Daily Choice Zone",
      email: "hello@dcz.example",
      phone: "080 1234 5678",
      website: "dcz.example",
      addressLine1: "1 Market St",
      addressLine2: "Floor 2",
      city: "Bengaluru",
      state: "Karnataka",
      postalCode: "560001",
      country: "India",
    },
    currency: { code: "INR", symbol: "₹", locale: "en-IN", decimals: 2 },
    invoice: { prefix: "DCZ-INV", startNumber: 1, padding: 6, dueDays: 7, footer: "Thanks for your business", paymentTerms: "Due on receipt", notes: "" },
    creditNote: { prefix: "DCZ-CN", startNumber: 1, padding: 6 },
    refund: { windowDays: 7, refundShipping: false, reasons: [] },
    payment: { enabledMethods: ["upi", "cod"], codFee: 0 },
    order: { prefix: "DCZ", startNumber: 1000 },
    sku: { prefix: "SKU" },
  };
}

export function taxConfig(): TaxConfig {
  return {
    enabled: true,
    taxType: "GST",
    pricesIncludeTax: true,
    originState: "Karnataka",
    gstin: "29ABCDE1234F1Z5",
    rates: { cgst: 6, sgst: 6, igst: 12 },
  };
}

/** Answer the two config documents an invoice is printed with. */
export function serveBillingConfig() {
  api.get("/site/billing-config", billingConfig());
  api.get("/site/tax-config", taxConfig());
}
