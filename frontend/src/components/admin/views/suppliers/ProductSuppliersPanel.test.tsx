import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, signIn } from "@/test/render";
import { supplierProduct } from "@/test/suppliers-fixtures";

import { ProductSuppliersPanel } from "./ProductSuppliersPanel";

describe("ProductSuppliersPanel", () => {
  it("asks nothing for a product that hasn't been saved yet", () => {
    renderUI(<ProductSuppliersPanel productId="" />);
    expect(api.calls).toHaveLength(0);
  });

  it("shows a placeholder while loading", () => {
    api.get("/admin/products/PRD001/suppliers", () => new Promise(() => undefined));
    renderUI(<ProductSuppliersPanel productId="PRD001" />);
    expect(screen.getByLabelText("Loading suppliers")).toHaveAttribute("aria-busy", "true");
  });

  it("lists the product's suppliers with cost, MOQ, lead time and status", async () => {
    signIn("admin", "adm");
    api.get("/admin/products/PRD001/suppliers", [
      supplierProduct(),
      supplierProduct({ id: 4, supplierId: "SUP002", supplierName: "Blue Looms", supplierStatus: "inactive", supplierSku: "", purchaseCost: 470.25, leadTimeDays: null, status: "inactive", preferred: false }),
    ]);
    renderUI(<ProductSuppliersPanel productId="PRD001" />);

    expect(await screen.findByRole("link", { name: "Anvi Textiles" })).toHaveAttribute("href", "/admin/suppliers/detail?id=SUP001");
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Preferred");
    expect(rows[1]).toHaveTextContent("AT-K-01");
    expect(rows[1]).toHaveTextContent("₹450");
    expect(rows[1]).toHaveTextContent("7 d");
    expect(rows[1]).toHaveTextContent("Active link");
    expect(rows[2]).toHaveTextContent("₹470.25");
    expect(rows[2]).toHaveTextContent("Inactive link");
    // The supplier's own status, when it isn't active.
    expect(rows[2]).toHaveTextContent("Inactive");
    expect(rows[2]).not.toHaveTextContent("Preferred");
    expect(api.last()!.headers.authorization).toBe("Bearer adm");
  });

  it("points to the suppliers when none is linked", async () => {
    api.get("/admin/products/PRD001/suppliers", []);
    renderUI(<ProductSuppliersPanel productId="PRD001" />);
    expect(await screen.findByText("No suppliers linked yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to suppliers" })).toHaveAttribute("href", "/admin/suppliers");
  });

  it("says so without the suppliers permission", async () => {
    api.get("/admin/products/PRD001/suppliers", fail(403, "Forbidden", "FORBIDDEN"));
    renderUI(<ProductSuppliersPanel productId="PRD001" />);
    expect(await screen.findByText("Your role doesn’t include suppliers.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers a retry when the list doesn't load", async () => {
    api.get("/admin/products/PRD001/suppliers", [supplierProduct()]);
    api.once("GET", "/admin/products/PRD001/suppliers", fail(500));
    const { user } = renderUI(<ProductSuppliersPanel productId="PRD001" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The suppliers didn’t load.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Anvi Textiles" })).toBeInTheDocument();
  });
});
