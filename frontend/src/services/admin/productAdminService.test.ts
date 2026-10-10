import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminProduct, ProductDraft } from "@/types/admin";

import { api, fail } from "@/test/api";
import { setUpAdmin } from "@/test/sliceB-admin";

import * as productAdmin from "./productAdminService";

function draft(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return {
    id: "",
    slug: "",
    name: "Cotton Kurta",
    brand: "Daily Choice",
    category: "women",
    subcategory: "kurtas",
    price: 599,
    originalPrice: 999,
    currency: "INR",
    rating: 0,
    reviewCount: 0,
    images: ["img.jpg"],
    colors: [],
    sizes: ["M"],
    description: "A breathable cotton kurta for everyday wear, in a relaxed fit.",
    material: "Cotton",
    tags: [],
    isNew: true,
    isTrending: false,
    isBestSeller: false,
    isFeatured: false,
    isReturnable: true,
    isReplaceable: true,
    stock: 10,
    sku: "SKU1",
    care: "",
    specifications: [],
    status: "active",
    lowStockThreshold: 5,
    reservedStock: 0,
    barcode: "",
    taxRatePercent: 5,
    seo: { metaTitle: "", metaDescription: "" },
    ...overrides,
  };
}

beforeEach(() => {
  setUpAdmin();
});

describe("listProducts / getProduct", () => {
  it("GETs their own endpoints", async () => {
    api.get(/^\/admin\/products/, []);
    await productAdmin.listProducts();
    expect(api.requests("GET", "/admin/products").at(-1)!.headers.authorization).toBe("Bearer test-token");

    api.get("/admin/products/P1", fail(404));
    await expect(productAdmin.getProduct("P1")).resolves.toBeNull();
  });
});

describe("validateProduct", () => {
  it("is empty for a complete, active draft", () => {
    expect(productAdmin.validateProduct(draft())).toEqual({});
  });

  it("requires a name, category and subcategory even for a draft", () => {
    const errors = productAdmin.validateProduct(draft({ name: "AB", category: "", subcategory: "", status: "draft" }));
    expect(errors).toEqual({ name: "Enter a product name.", category: "Choose a category.", subcategory: "Choose a product type." });
  });

  it("skips price/image/brand/description checks for a draft", () => {
    expect(productAdmin.validateProduct(draft({ status: "draft", price: 0, images: [], brand: "", description: "" }))).toEqual({});
  });

  it("requires a price above zero once published", () => {
    expect(productAdmin.validateProduct(draft({ price: 0 })).price).toBe("Enter a price above zero.");
  });

  it("requires the original price to be at least the selling price", () => {
    expect(productAdmin.validateProduct(draft({ price: 500, originalPrice: 400 })).originalPrice).toBeTruthy();
  });

  it("requires at least one image, shared or per colour", () => {
    expect(productAdmin.validateProduct(draft({ images: [], colors: [] })).images).toBeTruthy();
  });

  it("is satisfied by colour-specific photos alone", () => {
    expect(productAdmin.validateProduct(draft({ images: [], colors: [{ name: "Red", hex: "#f00", images: ["r.jpg"] }] })).images).toBeUndefined();
  });

  it("requires every colour to have photos once any of them do", () => {
    const errors = productAdmin.validateProduct(
      draft({ images: [], colors: [{ name: "Red", hex: "#f00", images: ["r.jpg"] }, { name: "Blue", hex: "#00f" }] }),
    );
    expect(errors.colors).toContain("Blue");
  });

  it("requires a brand of at least 2 characters", () => {
    expect(productAdmin.validateProduct(draft({ brand: "A" })).brand).toBeTruthy();
  });

  it("requires a description of at least 20 characters", () => {
    expect(productAdmin.validateProduct(draft({ description: "Too short" })).description).toBeTruthy();
  });

  it("requires non-negative stock", () => {
    expect(productAdmin.validateProduct(draft({ stock: -1 })).stock).toBeTruthy();
  });
});

describe("createProduct", () => {
  it("refuses an invalid draft without calling the API", async () => {
    const result = await productAdmin.createProduct(draft({ name: "A" }), "A1");
    expect(result.ok).toBe(false);
    expect(api.requests("POST")).toHaveLength(0);
  });

  it("trims the slug and sku before sending them (the id is the server's to issue, and is never sent)", async () => {
    api.post("/products", (req) => req.body);
    const result = await productAdmin.createProduct(draft({ slug: "  cotton-kurta  ", sku: " SKU1 " }), "A1");
    expect(result.ok).toBe(true);
    const sent = api.last("POST", "/products")!.body as AdminProduct;
    expect(sent).not.toHaveProperty("id");
    expect(sent.slug).toBe("cotton-kurta");
    expect(sent.sku).toBe("SKU1");
  });

  it("marks an active product with zero stock as out-of-stock", async () => {
    api.post("/products", (req) => req.body);
    const result = await productAdmin.createProduct(draft({ stock: 0, status: "active" }), "A1");
    expect((result as { data: AdminProduct }).data.status).toBe("out-of-stock");
  });

  it("makes a restocked out-of-stock product active again, and leaves drafts alone", async () => {
    api.post("/products", (req) => req.body);
    const restocked = await productAdmin.createProduct(draft({ stock: 12, status: "out-of-stock" }), "A1");
    expect((restocked as { data: AdminProduct }).data.status).toBe("active");
    const unpublished = await productAdmin.createProduct(draft({ stock: 12, status: "draft" }), "A1");
    expect((unpublished as { data: AdminProduct }).data.status).toBe("draft");
  });

  it("counts reserved units as gone", () => {
    expect(productAdmin.statusForStock("active", 4, 4)).toBe("out-of-stock");
    expect(productAdmin.statusForStock("out-of-stock", 5, 4)).toBe("active");
    expect(productAdmin.statusForStock("archived", 0)).toBe("archived");
  });

  it("never lets the original price fall below the selling price", async () => {
    api.post("/products", (req) => req.body);
    const result = await productAdmin.createProduct(draft({ price: 500, originalPrice: 1000 }), "A1");
    void result;
    // originalPrice above price is fine; the floor only bites when original < price,
    // which validateProduct already refuses for a non-draft — a draft can still hit it.
    const draftResult = await productAdmin.createProduct(draft({ status: "draft", price: 500, originalPrice: 100 }), "A1");
    expect((draftResult as { data: AdminProduct }).data.originalPrice).toBe(500);
  });
});

describe("updateProduct", () => {
  it("refuses an invalid draft", async () => {
    const result = await productAdmin.updateProduct(draft({ id: "P1", name: "A" }), "A1");
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses when the product no longer exists", async () => {
    api.get("/admin/products/P1", fail(404));
    const result = await productAdmin.updateProduct(draft({ id: "P1" }), "A1");
    expect(result).toEqual({ ok: false, reason: "That product no longer exists." });
  });

  it("looks the existing product up before writing (so a deleted-concurrently edit is refused)", async () => {
    api.get("/admin/products/P1", { id: "P1", createdAt: "2020-01-01T00:00:00Z" });
    api.put("/products/P1", (req) => req.body);
    const result = await productAdmin.updateProduct(draft({ id: "P1" }), "A1");
    expect(result.ok).toBe(true);
    expect(api.requests("GET", "/admin/products/P1")).toHaveLength(1);
  });

  it("sends an empty slug as-is rather than deriving one, unlike create (the server derives it on update)", async () => {
    api.get("/admin/products/P1", { id: "P1" });
    api.put("/products/P1", (req) => req.body);
    await productAdmin.updateProduct(draft({ id: "P1", slug: "  " }), "A1");
    expect(api.last("PUT", "/products/P1")!.body).toMatchObject({ slug: "" });
  });
});

describe("deleteProduct", () => {
  it("refuses when missing, deletes and reports the name otherwise", async () => {
    api.get("/admin/products/missing", fail(404));
    await expect(productAdmin.deleteProduct("missing")).resolves.toEqual({ ok: false, reason: "That product no longer exists." });

    api.get("/admin/products/P1", { id: "P1", name: "Kurta" });
    api.delete("/products/P1", {});
    await expect(productAdmin.deleteProduct("P1")).resolves.toEqual({ ok: true, data: "Kurta" });
  });
});

describe("duplicateProduct", () => {
  it("refuses when the source no longer exists", async () => {
    api.get("/admin/products/missing", fail(404));
    const result = await productAdmin.duplicateProduct("missing", "A1");
    expect(result).toEqual({ ok: false, reason: "That product no longer exists." });
  });

  it("copies with a (copy) suffix, blank identifiers, draft status and zeroed merchandising flags", async () => {
    api.get("/admin/products/P1", {
      id: "P1", name: "Kurta", slug: "kurta", sku: "SKU1", status: "active",
      isNew: true, isTrending: true, isBestSeller: true, isFeatured: true,
      rating: 4.5, reviewCount: 20, reservedStock: 3, images: ["fallback.jpg"], sharedImages: ["shared.jpg"],
    });
    api.post("/products", (req) => req.body);
    const result = await productAdmin.duplicateProduct("P1", "A1");
    const sent = api.last("POST", "/products")!.body as AdminProduct;
    expect(sent).not.toHaveProperty("id");
    expect(sent).toMatchObject({
      slug: "", sku: "", name: "Kurta (copy)", status: "draft",
      isNew: false, isTrending: false, isBestSeller: false, isFeatured: false,
      reservedStock: 0, images: ["shared.jpg"],
    });
    expect(result.ok).toBe(true);
  });

  it("falls back to images when there are no shared ones", async () => {
    api.get("/admin/products/P1", { id: "P1", name: "Kurta", images: ["fallback.jpg"] });
    api.post("/products", (req) => req.body);
    const result = await productAdmin.duplicateProduct("P1", "A1");
    expect((result as { data: AdminProduct }).data.images).toEqual(["fallback.jpg"]);
  });
});

describe("setProductStatus", () => {
  it("refuses when missing", async () => {
    api.get("/admin/products/missing", fail(404));
    const result = await productAdmin.setProductStatus("missing", "archived", "A1");
    expect(result).toEqual({ ok: false, reason: "That product no longer exists." });
  });

  it("writes the new status", async () => {
    api.get("/admin/products/P1", { id: "P1", status: "active" });
    api.put("/products/P1", (req) => req.body);
    const result = await productAdmin.setProductStatus("P1", "archived", "A1");
    expect(result).toMatchObject({ ok: true, data: { status: "archived" } });
    // `updatedBy` is not part of the payload — the server records the actor from the token.
    expect(api.last("PUT", "/products/P1")!.body).not.toHaveProperty("updatedBy");
  });
});

describe("emptyProductDraft", () => {
  it("is a blank draft status with sensible defaults", () => {
    const empty = productAdmin.emptyProductDraft();
    expect(empty).toMatchObject({ id: "", status: "draft", brand: "Daily Choice", isNew: true, lowStockThreshold: 8, stock: 0 });
  });
});

describe("uploadProductImage", () => {
  it("refuses a non-image file without calling the API", async () => {
    const file = new File(["x"], "doc.pdf", { type: "application/pdf" });
    const result = await productAdmin.uploadProductImage(file);
    expect(result).toEqual({ ok: false, reason: "doc.pdf is not an image." });
    expect(api.requests("POST")).toHaveLength(0);
  });

  it("refuses a file larger than 8 MB", async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const file = new File([big], "huge.png", { type: "image/png" });
    const result = await productAdmin.uploadProductImage(file);
    expect(result).toEqual({ ok: false, reason: "huge.png is larger than 8 MB." });
  });

  it("posts valid images as FormData and resolves with the server's url", async () => {
    api.post("/admin/uploads/images", { url: "https://cdn/x.jpg" });
    const file = new File(["x"], "photo.png", { type: "image/png" });
    const result = await productAdmin.uploadProductImage(file);
    expect(result).toEqual({ ok: true, data: "https://cdn/x.jpg" });
    expect(api.last("POST", "/admin/uploads/images")!.body).toBeInstanceOf(FormData);
  });

  it("prefixes the server's error with the file name", async () => {
    api.post("/admin/uploads/images", fail(413, "Image too large after re-encoding"));
    const file = new File(["x"], "photo.png", { type: "image/png" });
    const result = await productAdmin.uploadProductImage(file);
    expect(result).toEqual({ ok: false, reason: "photo.png: Image too large after re-encoding" });
  });
});

describe("photoUploadAvailable", () => {
  it("reads the config once and caches the answer", async () => {
    vi.resetModules();
    const fresh = await import("./productAdminService");
    api.get("/admin/uploads/config", { enabled: true });
    await expect(fresh.photoUploadAvailable()).resolves.toBe(true);
    await expect(fresh.photoUploadAvailable()).resolves.toBe(true);
    expect(api.requests("GET", "/admin/uploads/config")).toHaveLength(1);
  });

  it("is false and not cached when the request fails, so the next call retries", async () => {
    vi.resetModules();
    const fresh = await import("./productAdminService");
    api.get("/admin/uploads/config", fail(500));
    await expect(fresh.photoUploadAvailable()).resolves.toBe(false);
    api.get("/admin/uploads/config", { enabled: true });
    await expect(fresh.photoUploadAvailable()).resolves.toBe(true);
  });
});
