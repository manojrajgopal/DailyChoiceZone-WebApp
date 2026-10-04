import { describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { emptyProductDraft } from "@/services/admin/productAdminService";

import { AdminProductForm } from "./AdminProductForm";

const PRODUCT = {
  ...emptyProductDraft(),
  id: "P1",
  name: "Linen shirt",
  category: "men",
  categoryId: "CAT002",
  subcategory: "shirts",
  status: "active",
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
  updatedBy: "A1",
};

const ATTRIBUTES = {
  productId: "P1",
  attributes: [
    {
      id: 1, code: "material", label: "Material", type: "select", unit: "",
      options: [{ id: 11, value: "cotton", label: "Cotton", position: 0 }],
      value: "cotton",
    },
  ],
};

describe("AdminProductForm — attributes", () => {
  it("shows the product's attribute values on its own section when editing", async () => {
    setLocation("/admin/products/edit?id=P1&section=attributes");
    api.get("/categories", []);
    api.get("/admin/products/P1", PRODUCT);
    api.get("/admin/products/P1/attributes", ATTRIBUTES);
    renderUI(<AdminProductForm mode="edit" />);

    expect(await screen.findByLabelText("Material")).toHaveValue("cotton");
    expect(screen.getByRole("button", { name: "Save attributes" })).toBeDisabled();
    // The product itself was seeded into the form once it arrived.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Edit Linen shirt" })).toBeInTheDocument());
  });

  it("has no attributes section for a product not yet saved", async () => {
    setLocation("/admin/products/new?section=attributes");
    api.get("/categories", []);
    renderUI(<AdminProductForm mode="create" />);
    expect(await screen.findByRole("heading", { name: "Add product" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save attributes" })).not.toBeInTheDocument();
    expect(api.requests("GET", /\/attributes$/)).toHaveLength(0);
  });
});

const CATEGORIES = [
  {
    id: "CAT001", slug: "women", name: "Women", description: "", image: "", order: 1, featured: false,
    groups: [{ name: "Tops", items: [{ slug: "kurtas", name: "Kurtas" }] }],
  },
  {
    id: "CAT002", slug: "men", name: "Men", description: "", image: "", order: 2, featured: false,
    groups: [{ name: "Tops", items: [{ slug: "shirts", name: "Shirts" }, { slug: "tees", name: "T-shirts" }] }],
  },
];

function categoryLookup() {
  lookupBackend("category", [
    idPreview("category", "CAT001", { title: "Women", volatile: false }),
    idPreview("category", "CAT002", { title: "Men", volatile: false }),
  ]);
}

const categoryField = () => screen.getByRole("combobox", { name: /Category ID/ });

describe("AdminProductForm — category by ID", () => {
  it("picks the category by Category ID, offers its product types, and saves categoryId", async () => {
    setLocation("/admin/products/new?section=basics");
    api.get("/categories", CATEGORIES);
    categoryLookup();
    api.post("/products", (request) => ({ ...PRODUCT, ...request.body, id: "PRD009" }));
    const { user } = renderUI(<AdminProductForm mode="create" />);

    const type = await screen.findByRole("combobox", { name: /Product type/ });
    expect(type).toBeDisabled();

    await user.type(await screen.findByLabelText(/Product name/), "Linen shirt");
    await user.type(categoryField(), "CAT");
    expect(await screen.findByRole("option", { name: "CAT001" })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "CAT002" }));

    // The chosen ID is shown; its name is displayed, resolved from the ID.
    expect(await screen.findByText("Men")).toBeInTheDocument();
    expect(type).toBeEnabled();
    expect(within(type).getByRole("option", { name: "T-shirts" })).toBeInTheDocument();
    expect(within(type).queryByRole("option", { name: "Kurtas" })).not.toBeInTheDocument();
    await user.selectOptions(type, "tees");

    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.last("POST", "/products")).toBeDefined());
    const body = api.last("POST", "/products")!.body;
    expect(body.categoryId).toBe("CAT002");
    expect(body.category).toBeUndefined();
    expect(body.subcategory).toBe("tees");
    // Suggestions were asked for by ID prefix only.
    expect(api.last("GET", "/admin/lookup/category")!.query.get("q")).toBe("CAT");
  });

  it("finds nothing for a category name", async () => {
    setLocation("/admin/products/new?section=basics");
    api.get("/categories", CATEGORIES);
    categoryLookup();
    const { user } = renderUI(<AdminProductForm mode="create" />);
    await screen.findByRole("combobox", { name: /Product type/ });
    await user.type(categoryField(), "Men");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("option", { name: "CAT002" })).not.toBeInTheDocument();
  });

  it("requires a category before saving", async () => {
    setLocation("/admin/products/new?section=basics");
    api.get("/categories", CATEGORIES);
    categoryLookup();
    const { user } = renderUI(<AdminProductForm mode="create" />);
    await user.type(await screen.findByLabelText(/Product name/), "Linen shirt");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Choose a category.")).toBeInTheDocument();
    expect(api.requests("POST", "/products")).toHaveLength(0);
  });

  it("seeds an existing product's Category ID and keeps its product type", async () => {
    setLocation("/admin/products/edit?id=P1&section=basics");
    api.get("/categories", CATEGORIES);
    api.get("/admin/products/P1", { ...PRODUCT, status: "draft" });
    categoryLookup();
    api.put("/products/P1", (request) => ({ ...PRODUCT, ...request.body }));
    const { user } = renderUI(<AdminProductForm mode="edit" />);

    expect(await screen.findByText("CAT002")).toBeInTheDocument();
    expect(await screen.findByText("Men")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Product type/ })).toHaveValue("shirts");

    await user.click(screen.getByRole("button", { name: "Change Category ID" }));
    await user.type(categoryField(), "CAT001");
    await user.click(await screen.findByRole("option", { name: "CAT001" }));
    // The old type does not exist in the new category, so it is cleared.
    expect(screen.getByRole("combobox", { name: /Product type/ })).toHaveValue("");
    await user.selectOptions(screen.getByRole("combobox", { name: /Product type/ }), "kurtas");
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.last("PUT", "/products/P1")).toBeDefined());
    expect(api.last("PUT", "/products/P1")!.body).toMatchObject({ categoryId: "CAT001", subcategory: "kurtas" });
  });
});
