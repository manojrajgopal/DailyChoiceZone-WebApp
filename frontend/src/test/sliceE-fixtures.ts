/**
 * Fixtures for slice E (pages, billing, growth and support tests).
 *
 * Plain objects shaped like what the API sends, with overrides, so a test
 * states only the fields it is about.
 */
import type {
  AuthSession,
  BillingBreakdown,
  Category,
  Collection,
  Product,
  ReviewSummary,
  SiteConfig,
  User,
} from "@/types";

import { api } from "./api";

export function siteConfig(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    name: "Daily Choice Zone",
    tagline: "Everyday, done well",
    description: "An everyday store.",
    currency: "INR",
    locale: "en-IN",
    url: "https://dcz.example",
    support: { email: "help@dcz.example", phone: "+91 80 1234 5678", hours: "9am–9pm, every day" },
    freeDeliveryThreshold: 1499,
    standardDeliveryFee: 79,
    returnWindowDays: 30,
    social: [],
    footer: [],
    trustPoints: [],
    ...overrides,
  };
}

export function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "PRD1",
    slug: "linen-shirt",
    name: "Linen Shirt",
    brand: "House",
    category: "men",
    subcategory: "shirts",
    price: 1299,
    originalPrice: 1599,
    discount: 19,
    currency: "INR",
    rating: 4.5,
    reviewCount: 12,
    images: ["/img/shirt-1.jpg", "/img/shirt-2.jpg"],
    colors: [{ name: "Indigo", hex: "#223" }],
    sizes: ["S", "M", "L"],
    description: "A breathable linen shirt.",
    material: "100% linen",
    tags: ["linen"],
    isNew: false,
    isTrending: false,
    isBestSeller: false,
    isFeatured: false,
    stock: 10,
    sku: "SKU-1",
    care: "Machine wash cold",
    specifications: [{ label: "Fit", value: "Regular" }],
    ...overrides,
  };
}

export function category(overrides: Partial<Category> = {}): Category {
  return {
    id: "CAT1",
    slug: "men",
    name: "Men",
    description: "Everything for men.",
    image: "/img/men.jpg",
    groups: [
      { name: "Clothing", items: [{ slug: "shirts", name: "Shirts" }, { slug: "trousers", name: "Trousers" }] },
    ],
    order: 1,
    featured: true,
    ...overrides,
  };
}

export function collection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: "COL1",
    slug: "summer",
    name: "Summer Edit",
    description: "Light pieces for hot days.",
    image: "/img/summer.jpg",
    productIds: ["PRD1"],
    featured: true,
    ...overrides,
  };
}

export function reviewSummary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    average: 0,
    total: 0,
    distribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: 0 })),
    ...overrides,
  };
}

export function user(overrides: Partial<User> = {}): User {
  return {
    id: "U1",
    firstName: "Asha",
    lastName: "Rao",
    email: "asha@example.com",
    phone: "9876543210",
    memberSince: "2025-01-01",
    emailVerified: true,
    ...overrides,
  };
}

export function session(overrides: Partial<User> = {}): AuthSession {
  return { user: user(overrides), token: "test-token" };
}

/** A breakdown in minor units (paise). */
export function breakdown(overrides: Partial<BillingBreakdown> = {}): BillingBreakdown {
  return {
    currency: "INR",
    itemCount: 1,
    subtotal: 129900,
    productDiscount: 30000,
    couponDiscount: 0,
    couponCode: null,
    shipping: 0,
    otherCharges: 0,
    taxableAmount: 115982,
    tax: { mode: "intra-state", taxableAmount: 115982, cgst: 6959, sgst: 6959, igst: 0, totalTax: 13918, ratePercent: 12 },
    grandTotal: 129900,
    pricesIncludeTax: true,
    ...overrides,
  };
}

/** A server cart (`GET /cart`) holding these products, one of each. */
export function serverCart(products: Product[] = [product()], overrides: Record<string, unknown> = {}) {
  const subtotal = products.reduce((sum, item) => sum + item.price * 100, 0);
  return {
    items: products.map((item, index) => ({
      id: index + 1,
      productId: item.id,
      size: item.sizes[0] ?? null,
      color: item.colors[0]?.name ?? null,
      quantity: 1,
      product: item,
      lineTotal: item.price * 100,
    })),
    bundles: [],
    issues: [],
    breakdown: breakdown({ itemCount: products.length, subtotal, grandTotal: subtotal }),
    freeDeliveryShortfall: 0,
    appliedCoupon: null,
    couponError: null,
    membership: null,
    delivery: null,
    ...overrides,
  };
}

/** The endpoints the storefront chrome (header, footer, promo strip) reads. */
export function serveChrome(config: SiteConfig = siteConfig()) {
  api.get("/site/config", config);
  api.get("/site/banners", [{ id: "B1", message: "Free delivery over ₹1,499" }]);
  api.get("/site/navigation", [{ id: "N1", label: "Women", href: "/category/women" }]);
}
