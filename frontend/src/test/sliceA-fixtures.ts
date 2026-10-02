/**
 * Fixture factories for sliceA's unit tests (lib/** and services/**).
 *
 * Each factory returns a minimal-but-valid object of its type, overridable via
 * a partial. Keeping these in one place means every test file builds the same
 * shape of `Product` / `Invoice` / etc, so a type change surfaces everywhere
 * at once instead of silently drifting between files.
 */
import type { BillingAddress, BillingConfig, Invoice, InvoiceLine, Payment } from "@/types";
import type { Product, ProductColor } from "@/types/product";

export function makeColor(overrides: Partial<ProductColor> = {}): ProductColor {
  return { name: "Charcoal", hex: "#333333", images: [], ...overrides };
}

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "P1",
    slug: "classic-shirt",
    name: "Classic Shirt",
    brand: "Daily Choice",
    category: "men",
    subcategory: "shirts",
    price: 999,
    originalPrice: 1299,
    discount: 23,
    currency: "INR",
    rating: 4.2,
    reviewCount: 120,
    images: ["/img/shirt.jpg"],
    colors: [makeColor()],
    sizes: ["S", "M", "L"],
    description: "A classic shirt.",
    material: "Cotton",
    tags: ["shirt", "formal"],
    isNew: false,
    isTrending: false,
    isBestSeller: false,
    isFeatured: false,
    stock: 10,
    sku: "SKU-1",
    care: "Machine wash",
    specifications: [],
    ...overrides,
  };
}

export function makeBillingAddress(overrides: Partial<BillingAddress> = {}): BillingAddress {
  return {
    fullName: "Asha Rao",
    phone: "9876543210",
    email: "asha@example.com",
    line1: "221B Baker Street",
    line2: "",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560001",
    country: "India",
    ...overrides,
  };
}

export function makeInvoiceLine(overrides: Partial<InvoiceLine> = {}): InvoiceLine {
  return {
    productId: "P1",
    name: "Classic Shirt",
    sku: "SKU-1",
    hsn: "6105",
    size: "M",
    color: "Charcoal",
    quantity: 1,
    unitPrice: 99900,
    lineSubtotal: 99900,
    discount: 0,
    taxableAmount: 99900,
    taxRatePercent: 18,
    cgst: 8991,
    sgst: 8991,
    igst: 0,
    tax: 17982,
    lineTotal: 117882,
    ...overrides,
  };
}

export function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "INV1",
    invoiceNumber: "DCZ-INV-2026-000001",
    orderId: "ORD1",
    orderNumber: "DCZ-ORD-2026-000001",
    customerId: "C1",
    customerName: "Asha Rao",
    customerEmail: "asha@example.com",
    status: "issued",
    issuedAt: "2026-09-01T10:00:00Z",
    dueAt: "2026-09-15T10:00:00Z",
    billingAddress: makeBillingAddress(),
    shippingAddress: makeBillingAddress(),
    placeOfSupply: "Karnataka",
    lines: [makeInvoiceLine()],
    breakdown: {
      currency: "INR",
      itemCount: 1,
      subtotal: 99900,
      productDiscount: 0,
      couponDiscount: 0,
      memberDiscount: 0,
      couponCode: null,
      shipping: 0,
      otherCharges: 0,
      taxableAmount: 99900,
      tax: {
        mode: "intra-state",
        taxableAmount: 99900,
        cgst: 8991,
        sgst: 8991,
        igst: 0,
        totalTax: 17982,
        ratePercent: 18,
      },
      grandTotal: 117882,
      pricesIncludeTax: false,
    },
    paymentId: "PAY1",
    paymentMethod: "upi",
    paymentStatus: "paid",
    amountPaid: 117882,
    amountRefunded: 0,
    notes: "",
    terms: "",
    ...overrides,
  };
}

export function makeBillingConfig(overrides: Partial<BillingConfig> = {}): BillingConfig {
  return {
    business: {
      legalName: "Daily Choice Zone Pvt Ltd",
      storeName: "Daily Choice Zone",
      email: "hello@dcz.example",
      phone: "9876500000",
      website: "https://dcz.example",
      addressLine1: "1 Market Street",
      addressLine2: "",
      city: "Bengaluru",
      state: "Karnataka",
      postalCode: "560001",
      country: "India",
    },
    currency: { code: "INR", symbol: "₹", locale: "en-IN", decimals: 2 },
    invoice: {
      prefix: "DCZ-INV-",
      startNumber: 1,
      padding: 6,
      dueDays: 14,
      footer: "Thank you for shopping with us.",
      paymentTerms: "Due on receipt",
      notes: "",
    },
    creditNote: { prefix: "DCZ-CN-", startNumber: 1, padding: 6 },
    refund: { windowDays: 7, refundShipping: false, reasons: ["Damaged", "Wrong item"] },
    payment: { enabledMethods: ["upi", "card", "cod"], codFee: 0 },
    order: { prefix: "DCZ-ORD-", startNumber: 1 },
    sku: { prefix: "SKU-" },
    ...overrides,
  };
}

export function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: "PAY1",
    transactionId: "TXN1",
    orderId: "ORD1",
    orderNumber: "DCZ-ORD-2026-000001",
    invoiceId: "INV1",
    invoiceNumber: "DCZ-INV-2026-000001",
    customerId: "C1",
    customerName: "Asha Rao",
    customerEmail: "asha@example.com",
    amount: 117882,
    refundedAmount: 0,
    method: "upi",
    status: "paid",
    provider: "mock",
    createdAt: "2026-09-01T10:00:00Z",
    capturedAt: "2026-09-01T10:01:00Z",
    timeline: [],
    instrumentHint: "UPI ****1234",
    ...overrides,
  };
}
