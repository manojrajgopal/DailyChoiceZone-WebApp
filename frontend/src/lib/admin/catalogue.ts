import productsJson from "@/data/products.json";
import productMetaJson from "@/data/admin/product-meta.json";

import type { Product } from "@/types";
import type { AdminProduct, ProductManagement } from "@/types/admin";

import { OVERLAY_KEYS, resolve } from "./mock-store";

/**
 * The single resolved catalogue, shared by the storefront and the admin portal.
 *
 * `products.json` holds the customer-facing fields and `admin/product-meta.json`
 * holds the management fields, joined here by id. That split keeps the customer
 * payload free of admin concerns while there is one product record — the thing
 * requirement 49 is about. A real schema would be one table; this is the same
 * shape arrived at by a join.
 *
 * Resolution is deliberately not cached. The overlay changes whenever an admin
 * saves, and a stale cache would show them their own edit missing. Joining 139
 * records is far cheaper than the class of bug that caching introduces here.
 */

type MetaRow = ProductManagement & { productId: string };

const BASE_PRODUCTS = productsJson as Product[];
const META_BY_ID = new Map(
  (productMetaJson as MetaRow[]).map((row) => [row.productId, row]),
);

/** Sensible management defaults for a product with no metadata row. */
function defaultMeta(product: Product): ProductManagement {
  return {
    status: product.stock > 0 ? "active" : "out-of-stock",
    lowStockThreshold: 8,
    reservedStock: 0,
    barcode: "",
    taxRatePercent: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    updatedBy: "adm_001",
    seo: {
      metaTitle: `${product.name} — ${product.brand} | Daily Choice Zone`,
      metaDescription: product.description.slice(0, 155),
    },
  };
}

/** The committed catalogue, before any admin edits. */
function baseAdminProducts(): AdminProduct[] {
  return BASE_PRODUCTS.map((product) => {
    const meta = META_BY_ID.get(product.id);
    // Pick the management fields explicitly rather than spreading and
    // discarding `productId` — no unused binding to explain.
    const management: ProductManagement = meta ?? defaultMeta(product);
    return { ...product, ...management };
  });
}

/** Every product the admin can see, including drafts and archived items. */
export function allAdminProducts(): AdminProduct[] {
  return resolve(baseAdminProducts(), OVERLAY_KEYS.products);
}

export function findAdminProduct(id: string): AdminProduct | null {
  return allAdminProducts().find((product) => product.id === id) ?? null;
}

/**
 * What the storefront is allowed to show.
 *
 * Drafts and archived products are admin-only — publishing is what `status`
 * controls, and leaking an unfinished product onto the shop would make the
 * Draft state meaningless.
 */
export function storefrontProducts(): Product[] {
  return allAdminProducts().filter(
    (product) => product.status === "active" || product.status === "out-of-stock",
  );
}

/** Generate the next product id that will not collide with an existing one. */
export function nextProductId(): string {
  const highest = allAdminProducts().reduce((max, product) => {
    const digits = Number.parseInt(product.id.replace(/\D/g, ""), 10);
    return Number.isFinite(digits) && digits > max ? digits : max;
  }, 0);
  return `prod_${String(highest + 1).padStart(3, "0")}`;
}

/** A slug that is unique across the catalogue, suffixing only when needed. */
export function uniqueSlug(desired: string, ignoreId?: string): string {
  const taken = new Set(
    allAdminProducts()
      .filter((product) => product.id !== ignoreId)
      .map((product) => product.slug),
  );
  if (!taken.has(desired)) return desired;

  let counter = 2;
  while (taken.has(`${desired}-${counter}`)) counter += 1;
  return `${desired}-${counter}`;
}

/**
 * Whether this product has a storefront page that actually exists.
 *
 * The storefront is a static export, so `/product/[slug]` pages are written at
 * build time from `products.json`. A product created or re-slugged in the
 * portal since then has no page until the next build, and linking to it would
 * be a guaranteed 404. Callers use this to disable that link rather than hand
 * an administrator a dead URL.
 */
export function hasStorefrontPage(slug: string): boolean {
  return BASE_PRODUCTS.some((product) => product.slug === slug);
}
