import { describe, expect, it, vi } from "vitest";

import { api, fail, hang } from "@/test/api";
import { lookupBackend, productPreview, supplierPreview } from "@/test/lookup-fixtures";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { poItem, purchaseOrder, supplier, supplierProduct } from "@/test/suppliers-fixtures";
import { useToastStore } from "@/store/toastStore";

import { AdminNewPurchaseOrderView, PoWarnings, PurchaseOrderForm, warningText } from "./AdminPurchaseOrderForm";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

// Suppliers and products are chosen by ID (docs/id-lookup.md): the lookup
// answers IDs and previews; the form reads only the one supplier chosen.
function backend({ links = [supplierProduct()] } = {}) {
  api.get("/admin/suppliers/SUP001", supplier());
  api.get("/admin/suppliers/SUP002", supplier({ id: "SUP002", code: "BLUE", name: "Blue Looms", status: "inactive" }));
  api.get("/admin/suppliers/SUP001/products", links);
  api.get("/admin/suppliers/SUP002/products", []);
  lookupBackend("supplier", [supplierPreview(), supplierPreview({ id: "SUP002", code: "BLUE", name: "Blue Looms", status: "inactive" })]);
  lookupBackend("product", [
    productPreview(),
    productPreview({ id: "PRD002", name: "Linen Shirt", sku: "DCZ-ME0002", price: 1299, stock: 10 }),
    productPreview({ id: "PRD003", name: "Old Scarf", sku: "DCZ-AC0003", status: "archived" }),
  ]);
}

const supplierField = () => screen.getByRole("combobox", { name: "Supplier ID" });
const chosenSupplier = (id: string) => screen.findByRole("region", { name: `Selected Supplier: ${id}` });
const alerts = () => screen.queryAllByRole("alert").map((node) => node.textContent);
const lines = () => within(screen.getByRole("list", { name: "Order lines" })).getAllByRole("listitem");
const save = () => screen.getByRole("button", { name: /^(Save as draft|Save changes)$/ });
function errorOf(field: HTMLElement): string | null {
  const ids = field.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)).find((node) => node?.getAttribute("role") === "alert")?.textContent ?? null;
}

async function openNew(href = "/admin/purchase-orders/new?supplier=SUP001") {
  setLocation(href);
  const view = renderUI(<AdminNewPurchaseOrderView />);
  await screen.findByRole("combobox", { name: /Product ID/ });
  return view;
}

async function addLinked(user: ReturnType<typeof renderUI>["user"], productId = "PRD001") {
  const select = await screen.findByLabelText(/^Add from Anvi Textiles's products/);
  await user.selectOptions(select, productId);
}

async function addAny(user: ReturnType<typeof renderUI>["user"], productId = "PRD002", name = "Linen Shirt") {
  await user.type(screen.getByRole("combobox", { name: /^Add any product — Product ID or SKU/ }), productId);
  await user.click(await screen.findByRole("option", { name: productId }));
  await screen.findByLabelText(`Quantity of ${name}`);
}

describe("AdminNewPurchaseOrderView", () => {
  describe("choosing the supplier", () => {
    it("preselects the supplier from the URL by its ID and offers its linked products", async () => {
      signIn("admin", "adm");
      backend();
      await openNew();
      expect(screen.getByRole("heading", { name: "New purchase order" })).toBeInTheDocument();
      const chosen = await chosenSupplier("SUP001");
      expect(await within(chosen).findByText("Anvi Textiles")).toBeInTheDocument();
      expect(await screen.findByText("Billing state: Karnataka")).toBeInTheDocument();
      const linked = await screen.findByLabelText(/^Add from Anvi Textiles's products/);
      expect(within(linked).getByRole("option", { name: "PRD001 · Cotton Kurta · DCZ-WO0001 · ₹450" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "View supplier" })).toHaveAttribute("href", "/admin/suppliers/detail?id=SUP001");
      expect(api.last("GET", "/admin/suppliers/SUP001/products")!.headers.authorization).toBe("Bearer adm");
      // One supplier was read, exactly — never the supplier list.
      expect(api.requests("GET", "/admin/suppliers")).toHaveLength(0);
    });

    it("starts without a supplier, then takes one picked by Supplier ID", async () => {
      backend();
      const { user } = await openNew("/admin/purchase-orders/new");
      expect(supplierField()).toHaveValue("");
      expect(screen.getByText(/Choose a supplier, then add products./)).toBeInTheDocument();
      expect(api.requests("GET", /\/products$/)).toHaveLength(0);

      await user.type(supplierField(), "SUP0");
      expect(await screen.findByRole("option", { name: "SUP001" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "SUP002" })).toBeInTheDocument();
      await user.click(screen.getByRole("option", { name: "SUP001" }));
      expect(await chosenSupplier("SUP001")).toBeInTheDocument();
      expect(await screen.findByLabelText(/^Add from Anvi Textiles's products/)).toBeInTheDocument();
    });

    it("matches suppliers by ID, not by name", async () => {
      backend();
      const { user } = await openNew("/admin/purchase-orders/new");
      await user.type(supplierField(), "Textiles");
      expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
    });

    it("won't raise an order with an inactive supplier", async () => {
      backend();
      const { user } = await openNew("/admin/purchase-orders/new?supplier=SUP002");
      await waitFor(() => expect(alerts()).toContain("This supplier isn't active. Activate it before raising a purchase order."));
      await addAny(user);
      await user.type(screen.getByLabelText("Unit cost of Linen Shirt"), "100");
      await user.click(save());
      expect(api.requests("POST", "/admin/purchase-orders")).toHaveLength(0);
    });

    it("explains a missing suppliers permission", async () => {
      backend();
      api.get("/admin/suppliers/SUP001", fail(403, "Forbidden", "FORBIDDEN"));
      setLocation("/admin/purchase-orders/new?supplier=SUP001");
      renderUI(<AdminNewPurchaseOrderView />);
      expect(await screen.findByText("Your role doesn't include suppliers")).toBeInTheDocument();
    });

    it("offers a retry when the supplier's details don't load", async () => {
      backend();
      api.once("GET", "/admin/suppliers/SUP001", fail(500));
      setLocation("/admin/purchase-orders/new?supplier=SUP001");
      const { user } = renderUI(<AdminNewPurchaseOrderView />);
      expect(await screen.findByText(/The supplier’s details didn’t load./)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("Billing state: Karnataka")).toBeInTheDocument();
    });
  });

  describe("lines", () => {
    it("needs a supplier and a product", async () => {
      backend();
      const { user } = await openNew("/admin/purchase-orders/new");
      await user.click(save());
      expect(alerts()).toContain("Choose a supplier.");
      expect(screen.getByText("Add at least one product.")).toBeInTheDocument();
      expect(api.requests("POST", "/admin/purchase-orders")).toHaveLength(0);
    });

    it("fills in a linked product's MOQ, cost and supplier SKU, and warns below the MOQ", async () => {
      backend();
      const { user } = await openNew();
      await addLinked(user);
      const [line] = lines();
      expect(line).toHaveTextContent("Cotton Kurta");
      expect(line).toHaveTextContent("DCZ-WO0001 · Supplier SKU AT-K-01");
      expect(within(line!).getByLabelText("Quantity of Cotton Kurta")).toHaveValue("10");
      expect(within(line!).getByLabelText("Unit cost of Cotton Kurta")).toHaveValue("450");
      expect(within(line!).getByText("MOQ 10")).toBeInTheDocument();
      expect(screen.getByText("₹4,500", { selector: "strong" })).toBeInTheDocument();

      await user.clear(within(line!).getByLabelText("Quantity of Cotton Kurta"));
      await user.type(within(line!).getByLabelText("Quantity of Cotton Kurta"), "4");
      expect(within(line!).getByText("Below the minimum order of 10.")).toBeInTheDocument();
      expect(screen.getByText("₹1,800", { selector: "strong" })).toBeInTheDocument();
    });

    it("won't add the same product twice", async () => {
      backend();
      const { user } = await openNew();
      await addLinked(user);
      await addLinked(user);
      expect(lines()).toHaveLength(1);
      expect(screen.getByRole("alert")).toHaveTextContent("Cotton Kurta is already on this order.");
    });

    it("asks for the cost of a product the supplier isn't linked to", async () => {
      backend();
      const { user } = await openNew();
      await addAny(user);
      const [line] = lines();
      expect(line).toHaveTextContent("Not linked to this supplier — enter the cost.");
      expect(within(line!).getByLabelText("Quantity of Linen Shirt")).toHaveValue("1");
      await user.click(save());
      expect(errorOf(within(line!).getByLabelText("Unit cost of Linen Shirt"))).toBe(
        "Enter the unit cost — this product isn't linked to the supplier.",
      );
    });

    it("adds any product by its Product ID or SKU, never by name", async () => {
      backend();
      const { user } = await openNew();
      const field = screen.getByRole("combobox", { name: /^Add any product — Product ID or SKU/ });
      await user.type(field, "Linen");
      expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);

      await user.clear(field);
      await user.type(field, "DCZ-ME");
      const option = await screen.findByRole("option", { name: /PRD002/ });
      expect(option).toHaveTextContent("matched DCZ-ME0002");
      await user.click(option);
      expect(await screen.findByLabelText("Quantity of Linen Shirt")).toBeInTheDocument();
    });

    it("refuses a product that isn't on sale, with its ID", async () => {
      backend();
      const { user } = await openNew();
      await user.type(screen.getByRole("combobox", { name: /^Add any product — Product ID or SKU/ }), "PRD003");
      await user.click(await screen.findByRole("option", { name: "PRD003" }));
      expect(await screen.findByText("PRD003 (Old Scarf) is archived and can't be added.")).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Order lines" })).not.toBeInTheDocument();
    });

    it("explains a bad quantity, cost and tax rate on their line, and clears them as you fix them", async () => {
      backend();
      const { user } = await openNew();
      await addLinked(user);
      const quantity = screen.getByLabelText("Quantity of Cotton Kurta");
      const cost = screen.getByLabelText("Unit cost of Cotton Kurta");
      const tax = screen.getByLabelText("Tax rate of Cotton Kurta");
      await user.clear(quantity);
      await user.type(quantity, "0");
      await user.clear(cost);
      await user.type(cost, "-1");
      await user.type(tax, "120");
      await user.click(save());
      expect(errorOf(quantity)).toBe("A whole number from 1 to 10,00,000.");
      expect(errorOf(cost)).toBe("Enter a cost above ₹0.");
      expect(errorOf(tax)).toBe("A percentage from 0 to 100, or blank for the product's rate.");
      expect(api.requests("POST", "/admin/purchase-orders")).toHaveLength(0);

      await user.type(quantity, "5");
      expect(errorOf(quantity)).toBeNull();
      expect(errorOf(cost)).not.toBeNull();
    });

    it("removes a line and its errors", async () => {
      backend();
      const { user } = await openNew();
      await addAny(user);
      await user.click(save());
      expect(errorOf(screen.getByLabelText("Unit cost of Linen Shirt"))).not.toBeNull();
      await user.click(screen.getByRole("button", { name: "Remove Linen Shirt" }));
      expect(screen.queryByRole("list", { name: "Order lines" })).not.toBeInTheDocument();
      expect(screen.getByText(/No products yet./)).toBeInTheDocument();
    });
  });

  describe("saving", () => {
    it("saves a draft and opens it", async () => {
      backend();
      api.post("/admin/purchase-orders", purchaseOrder({ id: "POR009", poNumber: "DCZ-PO-2026-000009" }));
      const { user } = await openNew();
      await addLinked(user);
      await addAny(user);
      await user.clear(screen.getByLabelText("Quantity of Cotton Kurta"));
      await user.type(screen.getByLabelText("Quantity of Cotton Kurta"), "50");
      await user.type(screen.getByLabelText("Unit cost of Linen Shirt"), "650.5");
      await user.type(screen.getByLabelText("Tax rate of Linen Shirt"), "12");
      await user.type(screen.getByLabelText(/^Expected delivery/), "2026-10-15");
      await user.type(screen.getByLabelText(/^Supplier reference/), " Q-77 ");
      await user.type(screen.getByLabelText(/^Notes for this order/), "Rush");
      expect(screen.getByText("₹23,150.50", { selector: "strong" })).toBeInTheDocument();
      await user.click(save());

      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/admin/purchase-orders/detail?id=POR009"));
      expect(api.last("POST", "/admin/purchase-orders")!.body).toEqual({
        supplierId: "SUP001",
        items: [
          { productId: "PRD001", quantity: 50, unitCost: 450 },
          { productId: "PRD002", quantity: 1, unitCost: 650.5, taxRate: 12 },
        ],
        expectedAt: "2026-10-15",
        supplierReference: "Q-77",
        notes: "Rush",
      });
      expect(toasts()).toContain("success:DCZ-PO-2026-000009 saved as a draft");
    });

    it("lets the server use a linked product's cost when it's left blank", async () => {
      backend();
      api.post("/admin/purchase-orders", purchaseOrder());
      const { user } = await openNew();
      await addLinked(user);
      await user.clear(screen.getByLabelText("Unit cost of Cotton Kurta"));
      await user.click(save());
      await waitFor(() => expect(api.requests("POST", "/admin/purchase-orders")).toHaveLength(1));
      expect(api.last("POST", "/admin/purchase-orders")!.body.items).toEqual([{ productId: "PRD001", quantity: 10 }]);
    });

    it("shows the server's warnings before opening the saved order", async () => {
      backend();
      api.post("/admin/purchase-orders", purchaseOrder({ warnings: ["Cotton Kurta is below its MOQ of 10.", // The API may send a warning as an object; the type only promises strings.
        { message: "Expected date is a holiday." } as unknown as string] }));
      const { user } = await openNew();
      await addLinked(user);
      await user.click(save());

      expect(await screen.findByRole("heading", { name: "DCZ-PO-2026-000001 saved" })).toBeInTheDocument();
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent("Saved, with 2 warnings");
      expect(status).toHaveTextContent("Cotton Kurta is below its MOQ of 10.");
      expect(status).toHaveTextContent("Expected date is a holiday.");
      expect(screen.getByRole("link", { name: "Open DCZ-PO-2026-000001" })).toHaveAttribute("href", "/admin/purchase-orders/detail?id=POR001");
      expect(router.push).not.toHaveBeenCalled();
    });

    it("puts a supplier error on the supplier field", async () => {
      backend();
      api.post("/admin/purchase-orders", fail(409, "Anvi Textiles was archived a moment ago.", "SUPPLIER_INACTIVE"));
      const { user } = await openNew();
      await addLinked(user);
      await user.click(save());
      await waitFor(() => expect(alerts()).toContain("Anvi Textiles was archived a moment ago."));
      expect(toasts()).toContain("error:Anvi Textiles was archived a moment ago.");
    });

    it("puts a line error from the server on its line", async () => {
      backend();
      api.post("/admin/purchase-orders", fail(422, "Check the items.", "VALIDATION_ERROR", [{ field: "body.items.0.quantity", message: "Too many for one PO." }]));
      const { user } = await openNew();
      await addLinked(user);
      await user.click(save());
      await waitFor(() => expect(errorOf(screen.getByLabelText("Quantity of Cotton Kurta"))).toBe("Too many for one PO."));
    });

    it("shows a banner for an error that isn't about a field", async () => {
      backend();
      api.post("/admin/purchase-orders", fail(500, "Something broke.", "INTERNAL"));
      const { user } = await openNew();
      await addLinked(user);
      await user.click(save());
      const form = screen.getByRole("form", { name: "New purchase order" });
      expect(await within(form).findByText("Something broke.")).toHaveAttribute("role", "alert");
      expect(router.push).not.toHaveBeenCalled();
    });
  });
});

describe("PurchaseOrderForm — editing a draft", () => {
  it("prefills the draft's lines and saves the changes in place", async () => {
    backend();
    const onSaved = vi.fn();
    const onCancel = vi.fn();
    const saved = purchaseOrder({ notes: "changed" });
    api.put("/admin/purchase-orders/POR001", saved);
    const { user } = renderUI(<PurchaseOrderForm po={purchaseOrder({ items: [poItem({ quantity: 50, unitCost: 450, taxRate: 5 })] })} onSaved={onSaved} onCancel={onCancel} />);

    expect(screen.getByRole("heading", { name: "Edit DCZ-PO-2026-000001" })).toBeInTheDocument();
    expect(screen.getByLabelText("Quantity of Cotton Kurta")).toHaveValue("50");
    expect(screen.getByLabelText("Tax rate of Cotton Kurta")).toHaveValue("5");
    expect(screen.getByLabelText(/^Expected delivery/)).toHaveValue("2026-10-15");
    expect(await chosenSupplier("SUP001")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Quantity of Cotton Kurta"));
    await user.type(screen.getByLabelText("Quantity of Cotton Kurta"), "60");
    await user.click(save());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(api.last("PUT", "/admin/purchase-orders/POR001")!.body.items).toEqual([{ productId: "PRD001", quantity: 60, unitCost: 450, taxRate: 5 }]);
    expect(router.push).not.toHaveBeenCalled();
    expect(toasts()).toContain("success:Purchase order updated");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows the draft's supplier by its ID while the details load", async () => {
    api.get("/admin/suppliers/SUP001", hang());
    api.get("/admin/lookup/supplier/SUP001", hang());
    api.get("/admin/suppliers/SUP001/products", []);
    renderUI(<PurchaseOrderForm po={purchaseOrder()} onSaved={() => undefined} />);
    const chosen = await chosenSupplier("SUP001");
    expect(within(chosen).getByText("Loading details…")).toBeInTheDocument();
  });
});

describe("warnings", () => {
  it("reads a warning as text whatever its shape", () => {
    expect(warningText("Plain")).toBe("Plain");
    expect(warningText({ message: "Object", code: "X" })).toBe("Object");
    expect(warningText(42)).toBe("42");
  });

  it("shows nothing without warnings and a singular for one", () => {
    const { container, rerender } = renderUI(<PoWarnings warnings={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PoWarnings warnings={["Only one"]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved, with a warning");
  });
});
