/**
 * Fixtures for the cart component tests (sliceD / cart).
 *
 * Money conventions match the app: `Product.price`, `ResolvedCartLine.lineTotal`
 * and `CartTotals` are rupees; `BillingBreakdown` and `CartBundleLine` are paise.
 */
import type { BillingBreakdown, CartTotals, Coupon, Product, ResolvedCartLine } from "@/types";
import type { CartBundleLine } from "@/services/growthService";
import type { ServerCart } from "@/services/cartService";
import { useSessionStore } from "@/store/sessionStore";

import { api } from "./api";

export function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: "P1",
    slug: "linen-shirt",
    name: "Linen Shirt",
    brand: "Daily Choice",
    category: "men",
    subcategory: "casual-shirts",
    price: 1000,
    originalPrice: 1000,
    discount: 0,
    currency: "INR",
    rating: 4.5,
    reviewCount: 10,
    images: ["/img/p1.jpg"],
    colors: [],
    sizes: ["M"],
    description: "A shirt.",
    material: "Linen",
    tags: [],
    isNew: false,
    isTrending: false,
    isBestSeller: false,
    isFeatured: false,
    stock: 20,
    sku: "SKU-P1",
    care: "Wash cold",
    specifications: [],
    ...overrides,
  };
}

export function makeLine(overrides: Partial<ResolvedCartLine> = {}): ResolvedCartLine {
  const product = overrides.product ?? makeProduct();
  const quantity = overrides.quantity ?? 1;
  return {
    lineId: "L1",
    productId: product.id,
    size: null,
    color: null,
    quantity,
    addedAt: 0,
    product,
    lineTotal: product.price * quantity,
    lineOriginalTotal: product.originalPrice * quantity,
    ...overrides,
  };
}

/** A breakdown in paise. */
export function makeBreakdown(overrides: Partial<BillingBreakdown> = {}): BillingBreakdown {
  return {
    currency: "INR",
    itemCount: 1,
    subtotal: 100000,
    productDiscount: 0,
    couponDiscount: 0,
    couponCode: null,
    shipping: 0,
    otherCharges: 0,
    taxableAmount: 100000,
    tax: { mode: "none", taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0, ratePercent: 0 },
    grandTotal: 100000,
    pricesIncludeTax: true,
    ...overrides,
  };
}

/** Totals in rupees. */
export function makeTotals(overrides: Partial<CartTotals> = {}): CartTotals {
  return {
    itemCount: 1,
    subtotal: 1000,
    catalogueSavings: 0,
    couponDiscount: 0,
    deliveryFee: 0,
    total: 1000,
    freeDeliveryShortfall: 0,
    appliedCoupon: null,
    ...overrides,
  };
}

export function makeCoupon(overrides: Partial<Coupon> = {}): Coupon {
  return { code: "SAVE10", description: "10% off", type: "percent", value: 10, minSubtotal: 0, ...overrides };
}

/** A bundle in paise. */
export function makeBundle(overrides: Partial<CartBundleLine> = {}): CartBundleLine {
  return {
    id: 7,
    bundleId: 3,
    slug: "summer-set",
    name: "Summer Set",
    image: "/img/set.jpg",
    quantity: 1,
    unitPrice: 150000,
    regularUnitPrice: 200000,
    lineTotal: 150000,
    available: 10,
    maxPerOrder: 5,
    problem: null,
    components: [
      { productId: "P1", name: "Linen Shirt", slug: "linen-shirt", image: "", size: "M", color: "White", quantity: 1 },
      { productId: "P2", name: "Shorts", slug: "shorts", image: "", size: null, color: null, quantity: 2 },
    ],
    ...overrides,
  };
}

/** One server cart item (lineTotal in paise). */
export function makeServerItem(id: number, product: Product, quantity = 1) {
  return { id, productId: product.id, size: null, color: null, quantity, product, lineTotal: product.price * quantity * 100 };
}

export function makeServerCart(overrides: Partial<ServerCart> = {}): ServerCart {
  const product = makeProduct();
  return {
    items: [makeServerItem(1, product)],
    bundles: [],
    issues: [],
    breakdown: makeBreakdown(),
    freeDeliveryShortfall: 0,
    appliedCoupon: null,
    couponError: null,
    membership: null,
    delivery: null,
    ...overrides,
  };
}

export const CUSTOMER = {
  id: "C1",
  firstName: "Asha",
  lastName: "Rao",
  email: "asha@example.com",
  phone: "9999999999",
  joinedAt: "2025-01-01",
  emailVerified: true,
};

/**
 * Sign a customer in the way the cart hooks need: token in storage, a session
 * in the store, and `/auth/me` confirming it (the session check is module-level
 * and may or may not run, depending on what ran earlier in the file).
 */
export function signInCustomer() {
  window.localStorage.setItem("dcz:auth-token", "test-token");
  api.get("/auth/me", CUSTOMER);
  useSessionStore.setState({
    session: {
      token: "test-token",
      user: { id: "C1", firstName: "Asha", lastName: "Rao", email: "asha@example.com", phone: "9999999999", memberSince: "2025-01-01" },
    },
  });
}
