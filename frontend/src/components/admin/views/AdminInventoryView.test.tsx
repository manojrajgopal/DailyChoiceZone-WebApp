import { describe, expect, it } from "vitest";

import { api } from "@/test/api";
import { lookupBackend, productPreview } from "@/test/lookup-fixtures";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";

import { AdminInventoryView } from "./AdminInventoryView";

const ROW = {
  productId: "PRD001", name: "Cotton Kurta", sku: "DCZ-WO0001", category: "women", image: "",
  stock: 25, reserved: 0, available: 25, lowStockThreshold: 8, status: "in-stock",
};

const entry = (productId: string, quantityAfter: number, note: string) => ({
  id: quantityAfter, productId, reason: "restock", quantityBefore: 0, quantityAfter, delta: quantityAfter,
  note, by: "ADM001", at: "2026-10-01T10:00:00Z",
});

describe("AdminInventoryView — stock log", () => {
  it("filters the stock log to one product by Product ID; a name finds nothing", async () => {
    signIn("admin");
    api.get("/admin/inventory", [ROW, { ...ROW, productId: "PRD002", name: "Linen Shirt", sku: "DCZ-ME0002" }]);
    api.get("/admin/inventory/log", (request) =>
      request.query.get("productId") === "PRD002"
        ? [entry("PRD002", 7, "Linen restock")]
        : [entry("PRD001", 25, "Kurta restock"), entry("PRD002", 7, "Linen restock")]);
    lookupBackend("product", [productPreview(), productPreview({ id: "PRD002", name: "Linen Shirt", sku: "DCZ-ME0002" })]);
    const { user } = renderUI(<AdminInventoryView />);

    expect(await screen.findByText(/Kurta restock/)).toBeInTheDocument();
    const field = screen.getByRole("combobox", { name: "Stock changes for Product ID or SKU" });
    await user.type(field, "Linen");
    expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
    await user.clear(field);
    await user.type(field, "PRD00");
    await user.click(await screen.findByRole("option", { name: "PRD002" }));

    await waitFor(() => expect(api.last("GET", "/admin/inventory/log")!.query.get("productId")).toBe("PRD002"));
    await waitFor(() => expect(screen.queryByText(/Kurta restock/)).not.toBeInTheDocument());
    expect(screen.getByText(/Linen restock/)).toBeInTheDocument();
    // The inventory list itself is not narrowed by the log's filter.
    expect(api.last("GET", "/admin/inventory")!.query.has("q")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Remove Stock changes for Product ID or SKU filter" }));
    expect(await screen.findByText(/Kurta restock/)).toBeInTheDocument();
    expect(api.last("GET", "/admin/inventory/log")!.query.has("productId")).toBe(false);
  });

  it("says when the chosen product has no stock changes", async () => {
    signIn("admin");
    api.get("/admin/inventory", [ROW]);
    api.get("/admin/inventory/log", (request) => (request.query.get("productId") ? [] : [entry("PRD001", 25, "Kurta restock")]));
    lookupBackend("product", [productPreview(), productPreview({ id: "PRD002", name: "Linen Shirt", sku: "DCZ-ME0002" })]);
    const { user } = renderUI(<AdminInventoryView />);

    await screen.findByText(/Kurta restock/);
    await user.type(screen.getByRole("combobox", { name: "Stock changes for Product ID or SKU" }), "PRD002");
    await user.click(await screen.findByRole("option", { name: "PRD002" }));
    expect(await screen.findByText("No stock changes for that product.")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Filtered by Stock changes for Product ID or SKU PRD002" }))
      .getByRole("link", { name: "PRD002" })).toBeInTheDocument();
  });
});
