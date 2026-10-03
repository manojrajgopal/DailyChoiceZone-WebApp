import { ApiError, apiGet, apiPost } from "@/services/api/client";
import type { AdminProduct, AdminResult, ProductDraft, ProductStatus } from "@/types/admin";
import type { AdminProductListParams, AdminProductPage } from "@/types/searchAdmin";

import { discountPercent } from "@/lib/utils/format";

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

/** One page of the product list, filtered and counted on the server (search & filters). */
export function listProductsPage(params: AdminProductListParams = {}): Promise<AdminProductPage> {
  return adminDataSource.listProductsPage(params);
}

export function getProduct(id: string): Promise<AdminProduct | null> {
  return adminDataSource.getProduct(id);
}

/* ------------------------------------------------------------------ helpers */

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
    // Photographs: either shared ones, or one set per colour — and if some
    // colours have their own, all of them must, or choosing the others on
    // the product page would show a different colour's photos.
    const photographed = draft.colors.filter((colour) => colour.images?.length);
    if (photographed.length > 0 && photographed.length < draft.colors.length) {
      const missing = draft.colors
        .filter((colour) => !colour.images?.length)
        .map((colour) => colour.name);
      errors.colors = `Add photos for ${missing.join(", ")}, or remove the photos from every colour.`;
    }
    if (draft.images.length === 0 && photographed.length === 0) {
      errors.images = "Add at least one image, shared or for a colour.";
    }
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

  /**
   * The id, the slug and the SKU are the server's to issue.
   *
   * They have to be unique across the catalogue, and only one writer can
   * guarantee that. A browser picking the next id is a browser that picks the
   * same one as another browser.
   */
  const product = finalise({ ...draft, id: "", slug: draft.slug.trim(), sku: draft.sku.trim() }, by);

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

  // An empty slug means "derive it from the name" — the server does that, and
  // makes it unique, because only the server can see every other slug.
  const product = finalise({ ...draft, slug: draft.slug.trim() }, by);

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

  const now = new Date().toISOString();

  const copy: AdminProduct = {
    ...source,
    // The stored shared photos, not the storefront's fallback to the first
    // colour's — or the copy would hold that colour's photos twice.
    images: source.sharedImages ?? source.images,
    // Blank, so the server issues them — see `createProduct`.
    id: "",
    name: `${source.name} (copy)`,
    slug: "",
    sku: "",
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
    isReturnable: true,
    isReplaceable: true,
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

/**
 * Upload a product photograph; returns the address to store for it.
 *
 * The server checks it is really an image and re-encodes it, so what is kept
 * is never the file as sent. See `backend/app/api/routes/admin/uploads.py`.
 */
export async function uploadProductImage(file: File): Promise<AdminResult<string>> {
  if (!file.type.startsWith("image/")) {
    return { ok: false, reason: `${file.name} is not an image.` };
  }
  if (file.size > 8 * 1024 * 1024) {
    return { ok: false, reason: `${file.name} is larger than 8 MB.` };
  }
  const form = new FormData();
  form.append("file", file);
  try {
    const { url } = await apiPost<{ url: string }>("/admin/uploads/images", form, {
      auth: "admin",
    });
    return { ok: true, data: url };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ApiError && error.message
          ? `${file.name}: ${error.message}`
          : `${file.name} could not be uploaded.`,
    };
  }
}

let uploadsEnabled: Promise<boolean> | null = null;

/**
 * Whether photo upload is switched on — it is when cloud storage (Amazon S3)
 * is configured on the server. Asked once per visit; a failed answer is not
 * kept, so it is asked again next time.
 */
export function photoUploadAvailable(): Promise<boolean> {
  uploadsEnabled ??= apiGet<{ enabled: boolean }>("/admin/uploads/config", { auth: "admin" })
    .then((config) => config.enabled)
    .catch(() => {
      uploadsEnabled = null;
      return false;
    });
  return uploadsEnabled;
}
