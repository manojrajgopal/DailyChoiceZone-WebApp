import { describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, waitFor } from "@/test/render";
import { emptyProductDraft } from "@/services/admin/productAdminService";

import { AdminProductForm } from "./AdminProductForm";

const PRODUCT = {
  ...emptyProductDraft(),
  id: "P1",
  name: "Linen shirt",
  category: "men",
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
