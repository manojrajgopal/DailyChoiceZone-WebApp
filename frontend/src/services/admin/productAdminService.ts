import type { AdminProduct, AdminResult, ProductDraft, ProductStatus } from "@/types/admin";

import { nextProductId, uniqueSlug } from "@/lib/admin/catalogue";
import { discountPercent, slugify } from "@/lib/utils/format";

import { adminDataSource } from "./admin-data-source.instance";

/**
 * Product management.
 *
 * The service owns the rules the form should not have to know: how a discount
 * is derived, what makes a SKU, which fields a product must have before it can
 * be published, and how duplication produces something genuinely new.
 */

export function listProducts(): Promise<AdminProduct[]> {
  return adminDataSource.listProducts();
}

export function getProduct(id: string): Promise<AdminProduct | null> {
  return adminDataSource.getProduct(id);
}

/* ------------------------------------------------------------------ helpers */

/** `DCZ-WO0141` — department prefix plus a zero-padded sequence. */
function buildSku(category: string, id: string): string {
  const digits = id.replace(/\D/g, "").padStart(4, "0");
  return `DCZ-${category.slice(0, 2).toUpperCase()}${digits}`;
}

/**
 * Validation.
 *
 * A draft may be incomplete — that is what Draft means — so only the fields
 * needed to identify it are required. Publishing demands the rest, because an
 * active product with no price or image is a broken storefront page.
 */
export function validateProduct(draft: ProductDraft): Record<string, string> {
  const errors: Record<string, string> = {};

  if (draft.name.trim().length < 3) errors.name = "Enter a product name.";
  if (!draft.category) errors.category = "Choose a category.";
  if (!draft.subcategory) errors.subcategory = "Choose a product type.";

  if (draft.status !== "draft") {
    if (!(draft.price > 0)) errors.price = "Enter a price above zero.";
    if (draft.originalPrice < draft.price) {
      errors.originalPrice = "Original price cannot be below the selling price.";
    }
    if (draft.images.length === 0) errors.images = "Add at least one image.";
    if (draft.brand.trim().length < 2) errors.brand = "Enter a brand.";
    if (draft.description.trim().length < 20) {
      errors.description = "Write at least a couple of sentences.";
    }
    if (draft.stock < 0) errors.stock = "Stock cannot be negative.";
  }

  return errors;
}

/** Fill in everything the form does not collect directly. */
function finalise(draft: ProductDraft, by: string): AdminProduct {
  const now = new Date().toISOString();
  const originalPrice = Math.max(draft.originalPrice, draft.price);

  return {
    ...draft,
    originalPrice,
    // Always derived, never typed in — a discount badge that disagrees with
    // the prices beside it destroys trust faster than it sells anything.
    discount: discountPercent(draft.price, originalPrice),
    // Stock and status must agree, whichever the admin changed last.
    status: draft.stock <= 0 && draft.status === "active" ? "out-of-stock" : draft.status,
    createdAt: now,
    updatedAt: now,
    updatedBy: by,
  };
}

/* -------------------------------------------------------------------- create */

export async function createProduct(
  draft: ProductDraft,
  by: string,
): Promise<AdminResult<AdminProduct>> {
  const errors = validateProduct(draft);
  if (Object.keys(errors).length > 0) {
    return { ok: false, reason: Object.values(errors)[0] ?? "Check the form for errors." };
  }

  const id = nextProductId();
  const product = finalise(
    {
      ...draft,
      id,
      slug: uniqueSlug(draft.slug.trim() || slugify(draft.name)),
      sku: draft.sku.trim() || buildSku(draft.category, id),
    },
    by,
  );

  return { ok: true, data: await adminDataSource.createProduct(product) };
}

/* -------------------------------------------------------------------- update */

export async function updateProduct(
  draft: ProductDraft,
  by: string,
): Promise<AdminResult<AdminProduct>> {
  const errors = validateProduct(draft);
  if (Object.keys(errors).length > 0) {
    return { ok: false, reason: Object.values(errors)[0] ?? "Check the form for errors." };
  }

  const existing = await adminDataSource.getProduct(draft.id);
  if (!existing) return { ok: false, reason: "That product no longer exists." };

  const product = finalise(
    {
      ...draft,
      slug: uniqueSlug(draft.slug.trim() || slugify(draft.name), draft.id),
    },
    by,
  );

  // Preserve the original creation date through an edit.
  return {
    ok: true,
    data: await adminDataSource.updateProduct({ ...product, createdAt: existing.createdAt }),
  };
}

export async function deleteProduct(id: string): Promise<AdminResult<string>> {
  const existing = await adminDataSource.getProduct(id);
  if (!existing) return { ok: false, reason: "That product no longer exists." };
  await adminDataSource.deleteProduct(id);
  return { ok: true, data: existing.name };
}

/* ----------------------------------------------------------------- duplicate */

/**
 * Copy a product into a new draft.
 *
 * The copy gets a fresh id, SKU and slug, and lands as a **draft** — a
 * duplicate is a starting point, and publishing two identical products by
 * accident is the obvious failure mode here.
 */
export async function duplicateProduct(
  id: string,
  by: string,
): Promise<AdminResult<AdminProduct>> {
  const source = await adminDataSource.getProduct(id);
  if (!source) return { ok: false, reason: "That product no longer exists." };

  const newId = nextProductId();
  const now = new Date().toISOString();

  const copy: AdminProduct = {
    ...source,
    id: newId,
    name: `${source.name} (copy)`,
    slug: uniqueSlug(`${source.slug}-copy`),
    sku: buildSku(source.category, newId),
    status: "draft",
    // Merchandising flags are earned, not inherited.
    isNew: false,
    isTrending: false,
    isBestSeller: false,
    isFeatured: false,
    rating: 0,
    reviewCount: 0,
    reservedStock: 0,
    createdAt: now,
    updatedAt: now,
    updatedBy: by,
  };

  return { ok: true, data: await adminDataSource.createProduct(copy) };
}

/* ------------------------------------------------------------ status changes */

export async function setProductStatus(
  id: string,
  status: ProductStatus,
  by: string,
): Promise<AdminResult<AdminProduct>> {
  const product = await adminDataSource.getProduct(id);
  if (!product) return { ok: false, reason: "That product no longer exists." };

  return {
    ok: true,
    data: await adminDataSource.updateProduct({
      ...product,
      status,
      updatedAt: new Date().toISOString(),
      updatedBy: by,
    }),
  };
}

/** An empty product, used to seed the "Add product" form. */
export function emptyProductDraft(): ProductDraft {
  return {
    id: "",
    slug: "",
    name: "",
    brand: "Daily Choice",
    category: "",
    subcategory: "",
    price: 0,
    originalPrice: 0,
    currency: "INR",
    rating: 0,
    reviewCount: 0,
    images: [],
    colors: [],
    sizes: [],
    description: "",
    material: "",
    tags: [],
    isNew: true,
    isTrending: false,
    isBestSeller: false,
    isFeatured: false,
    stock: 0,
    sku: "",
    care: "",
    specifications: [],
    status: "draft",
    lowStockThreshold: 8,
    reservedStock: 0,
    barcode: "",
    taxRatePercent: 5,
    seo: { metaTitle: "", metaDescription: "" },
  };
}
