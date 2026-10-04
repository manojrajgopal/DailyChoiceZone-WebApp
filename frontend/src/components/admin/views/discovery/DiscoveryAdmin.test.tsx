import { describe, expect, it } from "vitest";

import type { Relationship } from "@/services/admin/discoveryAdminService";
import { api, fail } from "@/test/api";
import { idPreview, lookupBackend, productPreview } from "@/test/lookup-fixtures";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";

import { AdminSizeGuidesView } from "./AdminSizeGuidesView";
import { ProductDeliveryRulesPanel } from "./ProductDeliveryRulesPanel";
import { ProductRelationshipsPanel } from "./ProductRelationshipsPanel";
import { ProductSizeGuidePanel } from "./ProductSizeGuidePanel";

function relationship(id: number, relatedProductId: string, name: string, position: number): Relationship {
  return {
    id, productId: "PRD010", relatedProductId, type: "related", position, active: true, createdBy: "ADM001",
    createdAt: "2026-10-01T10:00:00",
    related: { id: relatedProductId, name, sku: `SKU-${relatedProductId}`, status: "active", price: 450, stock: 4, image: "" },
  };
}

describe("ProductRelationshipsPanel", () => {
  it("lists the chosen products in order and reorders them", async () => {
    signIn("admin");
    api.get("/admin/products/PRD010/relationships", [relationship(1, "PRD011", "Steel Bowl", 0),
      relationship(2, "PRD012", "Steel Spoon", 1)]);
    api.put("/admin/products/PRD010/relationships/order", [relationship(2, "PRD012", "Steel Spoon", 0),
      relationship(1, "PRD011", "Steel Bowl", 1)]);
    const { user } = renderUI(<ProductRelationshipsPanel productId="PRD010" />);

    const list = await screen.findByRole("list", { name: "Chosen products, in order" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Steel Bowl"), expect.stringContaining("Steel Spoon"),
    ]);
    await user.click(screen.getByRole("button", { name: "Move Steel Spoon up" }));
    await waitFor(() => expect(api.last("PUT", "/admin/products/PRD010/relationships/order")?.body)
      .toEqual({ type: "related", ids: [2, 1] }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("Steel Spoon"));
  });

  it("adds a product picked by its Product ID, with the reverse when asked", async () => {
    signIn("admin");
    api.get("/admin/products/PRD010/relationships", []);
    lookupBackend("product", [productPreview({ id: "PRD010", name: "Steel Plate" }), productPreview({ id: "PRD013", name: "Steel Glass", sku: "SKU-13" })]);
    api.post("/admin/products/PRD010/relationships", [relationship(3, "PRD013", "Steel Glass", 0)]);
    const { user } = renderUI(<ProductRelationshipsPanel productId="PRD010" />);

    await screen.findByText(/None chosen/);
    await user.click(screen.getByRole("checkbox", { name: /Also show this product on theirs/ }));
    const field = screen.getByRole("combobox", { name: /^Add products — Product ID or SKU/ });
    await user.type(field, "PRD01");
    // The product itself can't be related to itself.
    expect(await screen.findByRole("option", { name: /PRD010/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("option", { name: "PRD013" }));

    await waitFor(() => expect(api.last("POST", "/admin/products/PRD010/relationships")?.body).toEqual({
      relatedProductIds: ["PRD013"], type: "related", reciprocal: true,
    }));
    expect(await screen.findByRole("list", { name: "Chosen products, in order" })).toHaveTextContent("Steel Glass");
    expect(api.last("GET", "/admin/lookup/product")?.headers.authorization).toBe("Bearer test-token");
  });

  it("does not match products by name", async () => {
    signIn("admin");
    api.get("/admin/products/PRD010/relationships", []);
    lookupBackend("product", [productPreview({ id: "PRD013", name: "Steel Glass", sku: "SKU-13" })]);
    const { user } = renderUI(<ProductRelationshipsPanel productId="PRD010" />);
    await screen.findByText(/None chosen/);
    await user.type(screen.getByRole("combobox", { name: /^Add products — Product ID or SKU/ }), "glass");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    expect(api.requests("POST", "/admin/products/PRD010/relationships")).toHaveLength(0);
  });

  it("shows a refusal from the server", async () => {
    signIn("admin");
    api.get("/admin/products/PRD010/relationships", fail(403, "Your role does not include 'products'.", "PERMISSION_DENIED"));
    renderUI(<ProductRelationshipsPanel productId="PRD010" />);
    expect(await screen.findByText(/Your role doesn.t include products/)).toBeInTheDocument();
  });
});

describe("AdminSizeGuidesView", () => {
  it("creates a guide and reports the server's validation message", async () => {
    signIn("admin");
    api.get("/admin/size-guides", { items: [], pagination: { page: 1, page_size: 25, total: 0, total_pages: 0 },
      templates: { clothing: [{ key: "chest", label: "Chest", type: "measurement" }] } });
    api.post("/admin/size-guides", fail(422, "Size 'M', Chest: measurements must be greater than zero.",
      "SIZE_GUIDE_INVALID_VALUE"));
    const { user } = renderUI(<AdminSizeGuidesView />);

    await screen.findByText(/No size guides yet/);
    await user.click(screen.getByRole("button", { name: "New size guide" }));
    await user.type(screen.getByLabelText(/^Name/), "Men's T-Shirt");
    await user.type(screen.getByLabelText("Size 1"), "M");
    await user.type(screen.getByLabelText("M, Chest"), "-4");
    await user.click(screen.getByRole("button", { name: "Create size guide" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("measurements must be greater than zero");
    expect(api.last("POST", "/admin/size-guides")?.body).toMatchObject({
      name: "Men's T-Shirt", kind: "clothing", unit: "cm",
      columns: [{ key: "chest", label: "Chest", type: "measurement", required: true }],
      rows: [{ size: "M", values: { chest: "-4" } }],
    });
  });
});

describe("ProductDeliveryRulesPanel", () => {
  it("saves the product's own rules", async () => {
    signIn("admin");
    api.get("/admin/products/PRD010/delivery", { productId: "PRD010", codAllowed: true, expressAllowed: true,
      dispatchDays: null, note: "", exclusions: [], configured: false });
    api.put("/admin/products/PRD010/delivery", (req) => ({ productId: "PRD010", configured: true, ...req.body }));
    const { user } = renderUI(<ProductDeliveryRulesPanel productId="PRD010" />);

    await user.click(await screen.findByRole("switch", { name: /Cash on delivery/ }));
    await user.click(screen.getByRole("button", { name: "Add a place" }));
    await user.selectOptions(screen.getByLabelText("Where"), "state");
    await user.type(screen.getByLabelText("State"), "Assam");
    await user.click(screen.getByRole("button", { name: "Save delivery rules" }));

    await waitFor(() => expect(api.last("PUT", "/admin/products/PRD010/delivery")?.body).toEqual({
      codAllowed: false, expressAllowed: true, dispatchDays: null, note: "",
      exclusions: [{ kind: "state", value: "Assam", reason: "" }],
    }));
  });
});

function sizeGuide(overrides: Record<string, unknown> = {}) {
  return {
    id: "SZG001", name: "Men's Shirts", kind: "clothing", description: "", unit: "cm",
    columns: [{ key: "chest", label: "Chest", type: "measurement", required: true }],
    rows: [{ size: "M", values: { chest: { min: 96, max: 100 } } }],
    instructions: [], notes: "", status: "active", isDefault: false, categoryIds: ["CAT002"],
    products: 0, categories: 1, updatedAt: "2026-10-01T10:00:00Z", assignedProducts: [],
    ...overrides,
  };
}

describe("AdminSizeGuidesView — categories by ID", () => {
  it("adds a category by Category ID and saves the IDs; a name finds nothing", async () => {
    signIn("admin");
    api.get("/admin/size-guides", { items: [sizeGuide()], pagination: { page: 1, page_size: 25, total: 1, total_pages: 1 },
      templates: {} });
    api.get("/admin/size-guides/SZG001", sizeGuide());
    api.put("/admin/size-guides/SZG001/categories", { categories: ["CAT002", "CAT001"], movedFromOtherGuides: 0 });
    lookupBackend("category", [
      idPreview("category", "CAT001", { title: "Women", volatile: false }),
      idPreview("category", "CAT002", { title: "Men", volatile: false }),
    ]);
    const { user } = renderUI(<AdminSizeGuidesView />);

    await user.click(await screen.findByRole("button", { name: /Men's Shirts/ }));
    const field = await screen.findByRole("combobox", { name: /Add a category — Category ID/ });
    const chips = screen.getByRole("list", { name: /Chosen/ });
    expect(within(chips).getByText("CAT002")).toBeInTheDocument();

    await user.type(field, "Women");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "CAT0");
    await user.click(await screen.findByRole("option", { name: "CAT001" }));
    expect(within(chips).getByText("CAT001")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save categories" }));
    await waitFor(() => expect(api.last("PUT", "/admin/size-guides/SZG001/categories")?.body)
      .toEqual({ categoryIds: ["CAT002", "CAT001"] }));
    // The category list is never downloaded to label a checklist.
    expect(api.requests("GET", "/categories")).toHaveLength(0);
  });
});

describe("ProductSizeGuidePanel", () => {
  const state = (assignedGuideId: string | null) => ({
    assignedGuideId,
    source: assignedGuideId ? "product" : "category",
    guide: assignedGuideId ? { ...sizeGuide({ id: assignedGuideId }), sizeMatch: { missingFromGuide: [] } } : null,
  });

  it("assigns the product's own guide by Size guide ID", async () => {
    signIn("admin");
    api.get("/admin/products/PRD010/size-guide", state(null));
    api.put("/admin/products/PRD010/size-guide", state("SZG002"));
    lookupBackend("size_guide", [
      idPreview("size_guide", "SZG001", { title: "Men's Shirts", volatile: false }),
      idPreview("size_guide", "SZG002", { title: "Rings", volatile: false }),
    ]);
    const { user } = renderUI(<ProductSizeGuidePanel productId="PRD010" />);

    const field = await screen.findByRole("combobox", { name: /Size guide ID/ });
    await user.type(field, "Rings");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "SZG");
    expect(await screen.findByRole("option", { name: "SZG001" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "SZG002" }));

    await waitFor(() => expect(api.last("PUT", "/admin/products/PRD010/size-guide")?.body).toEqual({ sizeGuideId: "SZG002" }));
    expect(api.requests("GET", "/admin/size-guides")).toHaveLength(0);
  });

  it("clears the product's own guide back to the category's", async () => {
    signIn("admin");
    api.get("/admin/products/PRD010/size-guide", state("SZG001"));
    api.put("/admin/products/PRD010/size-guide", state(null));
    lookupBackend("size_guide", [idPreview("size_guide", "SZG001", { title: "Men's Shirts", volatile: false })]);
    const { user } = renderUI(<ProductSizeGuidePanel productId="PRD010" />);

    await user.click(await screen.findByRole("button", { name: /^Clear/ }));
    await waitFor(() => expect(api.last("PUT", "/admin/products/PRD010/size-guide")?.body).toEqual({ sizeGuideId: null }));
  });
});
