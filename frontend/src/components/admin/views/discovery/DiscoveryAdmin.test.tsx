import { describe, expect, it } from "vitest";

import type { Relationship } from "@/services/admin/discoveryAdminService";
import { api, fail, ok } from "@/test/api";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";

import { AdminSizeGuidesView } from "./AdminSizeGuidesView";
import { ProductDeliveryRulesPanel } from "./ProductDeliveryRulesPanel";
import { ProductRelationshipsPanel } from "./ProductRelationshipsPanel";

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

  it("finds a product and adds it, with the reverse when asked", async () => {
    signIn("admin");
    api.get("/admin/products/PRD010/relationships", []);
    api.get("/admin/products", ok([{ id: "PRD013", name: "Steel Glass", sku: "SKU-13", price: 300, status: "active" }]));
    api.post("/admin/products/PRD010/relationships", [relationship(3, "PRD013", "Steel Glass", 0)]);
    const { user } = renderUI(<ProductRelationshipsPanel productId="PRD010" />);

    await screen.findByText(/None chosen/);
    await user.click(screen.getByRole("checkbox", { name: /Also show this product on theirs/ }));
    await user.type(screen.getByPlaceholderText("Search by name, SKU or brand"), "glass");
    await user.click(await screen.findByRole("button", { name: "Add" }));

    await waitFor(() => expect(api.last("POST", "/admin/products/PRD010/relationships")?.body).toEqual({
      relatedProductIds: ["PRD013"], type: "related", reciprocal: true,
    }));
    expect(await screen.findByRole("list", { name: "Chosen products, in order" })).toHaveTextContent("Steel Glass");
    expect(api.last("GET", "/admin/products")?.headers.authorization).toBe("Bearer test-token");
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
