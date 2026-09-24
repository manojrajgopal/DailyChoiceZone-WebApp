/**
 * Generates the admin portal's mock data into `app/seed/data/admin/`.
 *
 * Everything here is derived from the real catalogue, so ids line up the way
 * they will once a database exists: an order line holds a `productId` that
 * resolves, a customer's `totalSpent` is the sum of their actual orders, and
 * the dashboard's counts agree with the rows behind them. Inventing these
 * files by hand is how those invariants quietly break.
 *
 * Output is deterministic — every value is seeded from a stable string — so
 * re-running produces no diff churn.
 *
 *   npm run data:admin
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const OUT = join(DATA, "admin");
mkdirSync(OUT, { recursive: true });

const read = (name) => JSON.parse(readFileSync(join(DATA, name), "utf8"));
const write = (name, value) => {
  writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`);
  return value;
};

const products = read("products.json");
const categories = read("categories.json");
const coupons = read("coupons.json");
const reviews = read("reviews.json");
const homepage = read("homepage.json");

/* ---------------------------------------------------------------- utilities */

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (arr, r) => arr[Math.floor(r() * arr.length) % arr.length];
const int = (r, min, max) => min + Math.floor(r() * (max - min + 1));

/** The build's "now". Fixed so generated data does not drift day to day. */
const NOW = new Date("2026-09-23T10:30:00.000Z");
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString();
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);

/** 1st, 2nd, 3rd, 4th … — teens are all "th". */
const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/* ---------------------------------------------------------------- customers */

const FIRST = [
  "Rahul", "Ananya", "Vikram", "Priya", "Karthik", "Sneha", "Aditya", "Meera",
  "Arjun", "Divya", "Nikhil", "Kavya", "Rohit", "Ishita", "Siddharth", "Tanvi",
  "Manish", "Neha", "Aarav", "Riya", "Varun", "Pooja", "Harsh", "Lakshmi",
  "Sameer", "Aditi", "Gaurav", "Shreya", "Imran", "Fatima", "Joseph", "Anita",
];
const LAST = [
  "Kumar", "Sharma", "Reddy", "Nair", "Iyer", "Patel", "Menon", "Rao",
  "Verma", "Joshi", "Desai", "Chopra", "Banerjee", "Gupta", "Pillai", "Shetty",
  "Singh", "Mehta", "Khan", "Fernandes",
];
const CITIES = [
  ["Bengaluru", "Karnataka", "5600"], ["Mumbai", "Maharashtra", "4000"],
  ["New Delhi", "Delhi", "1100"], ["Chennai", "Tamil Nadu", "6000"],
  ["Hyderabad", "Telangana", "5000"], ["Pune", "Maharashtra", "4110"],
  ["Kolkata", "West Bengal", "7000"], ["Ahmedabad", "Gujarat", "3800"],
  ["Jaipur", "Rajasthan", "3020"], ["Kochi", "Kerala", "6820"],
];
const STREETS = [
  "Rosewood Residency", "Brigade Heights", "Palm Grove Apartments", "Lake View Enclave",
  "Sunrise Towers", "Green Meadows", "Orchid Villa", "Maple Court",
];

const customers = [];
for (let i = 1; i <= 64; i += 1) {
  const id = `cust_${String(i).padStart(3, "0")}`;
  const r = rng(hash(id));
  const firstName = pick(FIRST, r);
  const lastName = pick(LAST, r);
  const [city, state, pinPrefix] = pick(CITIES, r);
  const joined = daysAgo(int(r, 20, 700));

  customers.push({
    id,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`,
    phone: `9${int(r, 100000000, 899999999)}`,
    status: r() < 0.04 ? "blocked" : "active",
    joinedAt: iso(joined),
    orderCount: 0,
    totalSpent: 0,
    lastOrderAt: null,
    addresses: [
      {
        id: `addr_${id}`,
        fullName: `${firstName} ${lastName}`,
        phone: `9${int(r, 100000000, 899999999)}`,
        line1: `${int(r, 101, 908)}, ${pick(STREETS, r)}`,
        line2: `${ordinal(int(r, 1, 18))} Main`,
        city,
        state,
        pincode: `${pinPrefix}${int(r, 10, 99)}`,
        type: r() < 0.75 ? "home" : "work",
        isDefault: true,
      },
    ],
    wishlistProductIds: Array.from({ length: int(r, 0, 4) }, () => pick(products, r).id),
  });
}

/* ------------------------------------------------------------------- orders */

const ORDER_STATUSES = [
  "pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "returned",
];
const PAYMENT_METHODS = ["UPI", "Credit card", "Net banking", "Cash on delivery"];

/** Status is a funnel: older orders are further along it. */
function statusForAge(ageDays, r) {
  if (ageDays > 21) {
    const roll = r();
    if (roll < 0.9) return "delivered";
    if (roll < 0.96) return "returned";
    return "cancelled";
  }
  if (ageDays > 10) return r() < 0.85 ? "delivered" : "shipped";
  if (ageDays > 5) return r() < 0.6 ? "shipped" : "processing";
  if (ageDays > 2) return r() < 0.5 ? "processing" : "confirmed";
  return r() < 0.5 ? "confirmed" : "pending";
}

const TIMELINE_ORDER = ["pending", "confirmed", "processing", "shipped", "delivered"];

const orders = [];
const inStock = products.filter((p) => p.stock > 0);

for (let i = 1; i <= 168; i += 1) {
  const id = `order_${String(i).padStart(4, "0")}`;
  const r = rng(hash(id));

  // Weight orders toward the recent past so the charts trend sensibly.
  const ageDays = Math.floor(Math.pow(r(), 1.8) * 360);
  const placedAt = daysAgo(ageDays);
  const customer = pick(customers, r);
  const status = statusForAge(ageDays, r);

  const lineCount = r() < 0.45 ? 1 : r() < 0.85 ? 2 : 3;
  const chosen = [];
  const seen = new Set();
  while (chosen.length < lineCount) {
    const product = pick(inStock, r);
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    chosen.push(product);
  }

  const lines = chosen.map((product) => {
    const quantity = r() < 0.75 ? 1 : int(r, 2, 3);
    return {
      productId: product.id,
      name: product.name,
      sku: product.sku,
      image: product.images[0] ?? "",
      size: product.sizes.length ? pick(product.sizes, r) : null,
      color: product.colors.length ? pick(product.colors, r).name : null,
      quantity,
      unitPrice: product.price,
      lineTotal: product.price * quantity,
    };
  });

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const originalTotal = chosen.reduce((sum, p, idx) => sum + p.originalPrice * lines[idx].quantity, 0);
  const coupon = r() < 0.28 ? pick(coupons, r) : null;

  let couponDiscount = 0;
  if (coupon && subtotal >= coupon.minSubtotal) {
    couponDiscount =
      coupon.type === "percent"
        ? Math.min(Math.round((subtotal * coupon.value) / 100), coupon.maxDiscount ?? Infinity)
        : coupon.type === "flat"
          ? Math.min(coupon.value, subtotal)
          : 0;
  }

  const deliveryFee = subtotal >= 999 ? 0 : 79;
  // Prices include tax, so this is the tax component, not an addition.
  const taxAmount = Math.round((subtotal - couponDiscount) * 0.05);
  const total = Math.max(0, subtotal - couponDiscount + deliveryFee);

  const isCod = r() < 0.22;
  const paymentMethod = isCod ? "Cash on delivery" : pick(PAYMENT_METHODS.slice(0, 3), r);
  const paymentStatus =
    status === "cancelled" ? "failed"
      : status === "returned" ? "refunded"
        : isCod ? (status === "delivered" ? "paid" : "cod-pending")
          : "paid";

  // The timeline only ever contains stages the order actually reached.
  const reachedIndex = TIMELINE_ORDER.indexOf(status);
  const stages = reachedIndex >= 0 ? TIMELINE_ORDER.slice(0, reachedIndex + 1) : ["pending", "confirmed"];
  /**
   * Stages are spaced 0.8 days apart, but never past "now" — a young order
   * that has already been confirmed would otherwise carry an event dated
   * tomorrow, which reads as broken data on the timeline.
   */
  const stageGap =
    stages.length > 1
      ? Math.min(DAY * 0.8, (NOW.getTime() - placedAt.getTime()) / (stages.length - 1))
      : 0;
  const timeline = stages.map((stage, index) => ({
    status: stage,
    at: iso(new Date(placedAt.getTime() + index * stageGap)),
    note: "",
    by: "system",
  }));
  if (status === "cancelled" || status === "returned") {
    timeline.push({
      status,
      at: iso(new Date(Math.min(placedAt.getTime() + 4 * DAY, NOW.getTime()))),
      note: status === "cancelled" ? "Cancelled at customer request." : "Returned — size did not fit.",
      by: "adm_002",
    });
  }

  orders.push({
    id,
    orderNumber: `DCZ${10000 + i}`,
    customerId: customer.id,
    customerName: `${customer.firstName} ${customer.lastName}`,
    customerEmail: customer.email,
    placedAt: iso(placedAt),
    status,
    paymentStatus,
    paymentMethod,
    lines,
    shippingAddress: customer.addresses[0],
    totals: {
      itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
      subtotal,
      catalogueSavings: Math.max(0, originalTotal - subtotal),
      couponDiscount,
      deliveryFee,
      total,
      freeDeliveryShortfall: Math.max(0, 999 - subtotal),
      appliedCoupon: couponDiscount > 0 ? coupon : null,
      taxAmount,
    },
    timeline,
    trackingNumber: ["shipped", "delivered", "returned"].includes(status)
      ? `DCZSHIP${int(r, 1000000, 9999999)}`
      : null,
  });
}

orders.sort((a, b) => b.placedAt.localeCompare(a.placedAt));

// Roll order history back onto the customers who placed them.
const byCustomer = new Map();
for (const order of orders) {
  if (order.status === "cancelled") continue;
  const entry = byCustomer.get(order.customerId) ?? { count: 0, spent: 0, last: null };
  entry.count += 1;
  entry.spent += order.totals.total;
  if (!entry.last || order.placedAt > entry.last) entry.last = order.placedAt;
  byCustomer.set(order.customerId, entry);
}
for (const customer of customers) {
  const entry = byCustomer.get(customer.id);
  if (!entry) continue;
  customer.orderCount = entry.count;
  customer.totalSpent = entry.spent;
  customer.lastOrderAt = entry.last;
}

/* --------------------------------------------------- product management meta */

const productMeta = products.map((product) => {
  const r = rng(hash(`meta-${product.id}`));
  const status = product.stock === 0 ? "out-of-stock" : r() < 0.04 ? "draft" : "active";
  const created = daysAgo(int(r, 5, 500));
  return {
    productId: product.id,
    status,
    lowStockThreshold: pick([5, 8, 10, 12], r),
    reservedStock: product.stock > 0 ? int(r, 0, Math.min(4, product.stock)) : 0,
    barcode: `890${int(r, 1000000000, 9999999999)}`,
    taxRatePercent: 5,
    createdAt: iso(created),
    updatedAt: iso(new Date(created.getTime() + int(r, 0, 60) * DAY)),
    updatedBy: pick(["adm_001", "adm_002", "adm_003"], r),
    seo: {
      metaTitle: `${product.name} — ${product.brand} | Daily Choice Zone`,
      metaDescription: product.description.slice(0, 155),
    },
  };
});

/* ---------------------------------------------------------------- analytics */

/** Sum revenue and order count per day from the orders that actually exist. */
function seriesFor(rangeDays, bucketCount, labelFor) {
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    label: labelFor(i, bucketCount),
    revenue: 0,
    orders: 0,
  }));
  const spanMs = rangeDays * DAY;
  const start = NOW.getTime() - spanMs;

  for (const order of orders) {
    if (order.status === "cancelled") continue;
    const t = new Date(order.placedAt).getTime();
    if (t < start || t > NOW.getTime()) continue;
    const index = Math.min(bucketCount - 1, Math.floor(((t - start) / spanMs) * bucketCount));
    buckets[index].revenue += order.totals.total;
    buckets[index].orders += 1;
  }
  return buckets;
}

function ordersWithin(days) {
  const start = NOW.getTime() - days * DAY;
  return orders.filter(
    (o) => o.status !== "cancelled" && new Date(o.placedAt).getTime() >= start,
  );
}

function snapshot(range, days, bucketCount, labelFor) {
  const within = ordersWithin(days);
  const previous = orders.filter((o) => {
    const t = new Date(o.placedAt).getTime();
    return o.status !== "cancelled" && t >= NOW.getTime() - days * 2 * DAY && t < NOW.getTime() - days * DAY;
  });

  const revenue = within.reduce((s, o) => s + o.totals.total, 0);
  const prevRevenue = previous.reduce((s, o) => s + o.totals.total, 0);
  const unitsSold = within.reduce((s, o) => s + o.totals.itemCount, 0);

  const categoryTotals = new Map();
  const productTotals = new Map();
  for (const order of within) {
    for (const line of order.lines) {
      const product = products.find((p) => p.id === line.productId);
      if (!product) continue;
      const cat = categoryTotals.get(product.category) ?? { revenue: 0, units: 0 };
      cat.revenue += line.lineTotal;
      cat.units += line.quantity;
      categoryTotals.set(product.category, cat);

      const prod = productTotals.get(product.id) ?? { unitsSold: 0, revenue: 0 };
      prod.unitsSold += line.quantity;
      prod.revenue += line.lineTotal;
      productTotals.set(product.id, prod);
    }
  }

  const statusCounts = new Map();
  for (const order of ordersWithin(days)) {
    statusCounts.set(order.status, (statusCounts.get(order.status) ?? 0) + 1);
  }

  const pct = (now, before) =>
    before === 0 ? (now > 0 ? 100 : 0) : Math.round(((now - before) / before) * 1000) / 10;

  return {
    range,
    revenue,
    orders: within.length,
    averageOrderValue: within.length ? Math.round(revenue / within.length) : 0,
    unitsSold,
    customers: new Set(within.map((o) => o.customerId)).size,
    revenueDelta: pct(revenue, prevRevenue),
    ordersDelta: pct(within.length, previous.length),
    series: seriesFor(days, bucketCount, labelFor),
    byCategory: [...categoryTotals.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.revenue - a.revenue),
    topProducts: [...productTotals.entries()]
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 8)
      .map(([productId, v]) => {
        const product = products.find((p) => p.id === productId);
        return {
          productId,
          name: product.name,
          image: product.images[0] ?? "",
          category: product.category,
          unitsSold: v.unitsSold,
          revenue: v.revenue,
          stock: product.stock,
        };
      }),
    byStatus: ORDER_STATUSES.map((status) => ({
      status,
      count: statusCounts.get(status) ?? 0,
    })).filter((s) => s.count > 0),
  };
}

const dayLabel = (i, n) => {
  const d = new Date(NOW.getTime() - (n - 1 - i) * DAY);
  return d.toISOString().slice(0, 10);
};
const monthLabel = (i, n) => {
  const d = new Date(NOW.getTime() - (n - 1 - i) * 30 * DAY);
  return d.toISOString().slice(0, 7);
};

const analytics = {
  today: snapshot("today", 1, 12, (i) => `${String(i * 2).padStart(2, "0")}:00`),
  "7d": snapshot("7d", 7, 7, dayLabel),
  "30d": snapshot("30d", 30, 30, dayLabel),
  "3m": snapshot("3m", 90, 12, (i, n) => dayLabel(i * 7, n * 7)),
  "1y": snapshot("1y", 365, 12, monthLabel),
};

/* ---------------------------------------------------------------- dashboard */

/**
 * Low stock counts *available* units, matching `stockStatus` in the admin
 * adapter. Ignoring reserved units here made the seeded figure disagree with
 * the one the dashboard recomputes on load.
 */
const lowStockCount = products.filter((p) => {
  const meta = productMeta.find((m) => m.productId === p.id);
  const available = Math.max(0, p.stock - (meta?.reservedStock ?? 0));
  return available > 0 && available <= (meta?.lowStockThreshold ?? 8);
}).length;

const thirty = analytics["30d"];

write("dashboard.json", {
  generatedAt: iso(NOW),
  stats: [
    { id: "sales", label: "Total sales", value: thirty.revenue, format: "currency", delta: thirty.revenueDelta, href: "/admin/reports", icon: "sales" },
    { id: "orders", label: "Orders", value: thirty.orders, format: "number", delta: thirty.ordersDelta, href: "/admin/orders", icon: "orders" },
    { id: "customers", label: "Customers", value: customers.length, format: "number", delta: 4.8, href: "/admin/customers", icon: "customers" },
    { id: "products", label: "Products", value: products.length, format: "number", delta: null, href: "/admin/products", icon: "products" },
    { id: "lowStock", label: "Low stock", value: lowStockCount, format: "number", delta: null, href: "/admin/inventory", icon: "alert" },
  ],
});

/* ------------------------------------------------------------------ reviews */

const adminReviews = reviews.map((review, index) => {
  const r = rng(hash(`ar-${review.id}`));
  const product = products.find((p) => p.id === review.productId);
  // Most historic reviews are already approved; a slice awaits moderation.
  const status = index % 17 === 0 ? "pending" : r() < 0.03 ? "rejected" : "approved";
  const customer = pick(customers, r);
  return {
    id: review.id,
    productId: review.productId,
    productName: product?.name ?? "Unknown product",
    productImage: product?.images[0] ?? "",
    customerId: customer.id,
    customerName: review.author,
    rating: review.rating,
    title: review.title,
    body: review.body,
    submittedAt: `${review.date}T09:00:00.000Z`,
    status,
    verifiedPurchase: review.verified,
  };
});

/* ------------------------------------------------------------------ coupons */

const adminCoupons = coupons.map((coupon, index) => {
  const r = rng(hash(`coupon-${coupon.code}`));
  const startsAt = daysAgo(int(r, 30, 200));
  const endsAt = index === 3 ? null : new Date(NOW.getTime() + int(r, -10, 120) * DAY);
  const expired = endsAt !== null && endsAt.getTime() < NOW.getTime();
  return {
    id: `coupon_${String(index + 1).padStart(3, "0")}`,
    code: coupon.code,
    description: coupon.description,
    type: coupon.type,
    value: coupon.value,
    minSubtotal: coupon.minSubtotal,
    maxDiscount: coupon.maxDiscount ?? null,
    startsAt: iso(startsAt),
    endsAt: endsAt ? iso(endsAt) : null,
    usageLimit: pick([null, 500, 1000, 2500], r),
    usageCount: int(r, 12, 480),
    status: expired ? "expired" : "active",
    createdAt: iso(startsAt),
  };
});

// One disabled and one scheduled, so every status is represented in the UI.
adminCoupons.push(
  {
    id: "coupon_005", code: "FESTIVE15", description: "15% off during the festive week",
    type: "percent", value: 15, minSubtotal: 1499, maxDiscount: 1000,
    startsAt: iso(new Date(NOW.getTime() + 14 * DAY)), endsAt: iso(new Date(NOW.getTime() + 28 * DAY)),
    usageLimit: 2000, usageCount: 0, status: "scheduled", createdAt: iso(daysAgo(3)),
  },
  {
    id: "coupon_006", code: "SAVE200", description: "₹200 off orders above ₹1,499",
    type: "flat", value: 200, minSubtotal: 1499, maxDiscount: null,
    startsAt: iso(daysAgo(90)), endsAt: null,
    usageLimit: 1000, usageCount: 734, status: "disabled", createdAt: iso(daysAgo(90)),
  },
);

/* ------------------------------------------------------------------ banners */

write("banners.json", [
  {
    id: "banner_001", title: "Free delivery on orders above ₹999",
    subtitle: "Dispatched within 24 hours from Bengaluru",
    image: "https://images.unsplash.com/photo-1523381210434-271e8be1f52b?auto=format&fit=crop&w=1400&q=80",
    buttonText: "Shop now", buttonLink: "/shop",
    startsAt: iso(daysAgo(60)), endsAt: null, active: true, displayOrder: 1,
  },
  {
    id: "banner_002", title: "15-day easy returns on everything",
    subtitle: "We arrange the pickup, no questions asked",
    image: "https://images.unsplash.com/photo-1485462537746-965f33f7f6a7?auto=format&fit=crop&w=1400&q=80",
    buttonText: "How returns work", buttonLink: "/returns",
    startsAt: iso(daysAgo(45)), endsAt: null, active: true, displayOrder: 2,
  },
  {
    id: "banner_003", title: "New here? Use WELCOME10 for 10% off",
    subtitle: "Valid on your first order",
    image: "https://images.unsplash.com/photo-1495121605193-b116b5b9c5fe?auto=format&fit=crop&w=1400&q=80",
    buttonText: "Start shopping", buttonLink: "/shop",
    startsAt: iso(daysAgo(30)), endsAt: null, active: true, displayOrder: 3,
  },
  {
    id: "banner_004", title: "Festive Edit is coming",
    subtitle: "Our biggest collection of the year, live next month",
    image: "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1400&q=80",
    buttonText: "Preview the edit", buttonLink: "/collection/home-refresh",
    startsAt: iso(new Date(NOW.getTime() + 20 * DAY)), endsAt: null, active: false, displayOrder: 4,
  },
]);

/* --------------------------------------------------------- homepage sections */

const SOURCE_MAP = {
  new: "new-arrivals", trending: "trending", bestsellers: "bestsellers",
  featured: "featured", recommended: "recommended", deals: "deals",
};
const TYPE_MAP = {
  "product-rail": "product-carousel", "category-grid": "category-grid",
  "collection-grid": "collection-grid", "editorial-split": "promo-banner",
  "trust-strip": "promo-banner",
};

write("homepage.json", homepage.sections.map((section, index) => ({
  id: section.id,
  type: TYPE_MAP[section.type] ?? "product-carousel",
  title: section.title ?? "Trust strip",
  subtitle: section.subtitle ?? "",
  source: section.source ? SOURCE_MAP[section.source] ?? null : null,
  limit: section.limit ?? 0,
  active: true,
  displayOrder: index + 1,
})));

/* ------------------------------------------------------------ notifications */

const pendingReviews = adminReviews.filter((r) => r.status === "pending").length;
const openOrders = orders.filter((o) => ["pending", "confirmed", "processing"].includes(o.status)).length;

write("notifications.json", [
  { id: "ntf_001", kind: "stock", title: `${lowStockCount} products are low in stock`, body: "Restock them before they sell out.", at: iso(daysAgo(0.05)), read: false, href: "/admin/inventory" },
  { id: "ntf_002", kind: "order", title: `${openOrders} orders need processing`, body: "Pending, confirmed and processing orders awaiting action.", at: iso(daysAgo(0.2)), read: false, href: "/admin/orders" },
  { id: "ntf_003", kind: "review", title: `${pendingReviews} reviews awaiting approval`, body: "Moderate them to publish on the storefront.", at: iso(daysAgo(0.6)), read: false, href: "/admin/reviews" },
  { id: "ntf_004", kind: "coupon", title: "FESTIVE15 goes live in 14 days", body: "Scheduled coupon — check the dates before launch.", at: iso(daysAgo(1.2)), read: true, href: "/admin/coupons" },
  { id: "ntf_005", kind: "system", title: "Homepage section order changed", body: "Limited Picks moved above Recommended For You.", at: iso(daysAgo(2)), read: true, href: "/admin/homepage" },
]);

/* ------------------------------------------------------------------- output */

write("customers.json", customers);
write("orders.json", orders);
write("product-meta.json", productMeta);
write("analytics.json", analytics);
write("reviews.json", adminReviews);
write("coupons.json", adminCoupons);

console.log(`customers.json     ${customers.length}`);
console.log(`orders.json        ${orders.length}`);
console.log(`product-meta.json  ${productMeta.length}`);
console.log(`reviews.json       ${adminReviews.length} (${pendingReviews} pending)`);
console.log(`coupons.json       ${adminCoupons.length}`);
console.log(`analytics.json     ${Object.keys(analytics).length} ranges`);
console.log(`30d revenue        ₹${thirty.revenue.toLocaleString("en-IN")} from ${thirty.orders} orders`);
console.log(`low stock          ${lowStockCount} products`);
