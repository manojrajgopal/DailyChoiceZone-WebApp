import { describe, expect, it, vi } from "vitest";

import type { SupplierProduct } from "@/types/suppliers";
import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { pickable, supplierProduct } from "@/test/suppliers-fixtures";
import { useToastStore } from "@/store/toastStore";

import { SupplierProductDialog } from "./SupplierProductDialog";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

function setup(link?: SupplierProduct, linkedProductIds: string[] = ["PRD001"]) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const view = renderUI(
    <SupplierProductDialog supplierId="SUP001" supplierName="Anvi Textiles" link={link} linkedProductIds={linkedProductIds} onClose={onClose} onSaved={onSaved} />,
  );
  return { ...view, dialog: screen.getByRole("dialog"), onClose, onSaved };
}

const field = (dialog: HTMLElement, label: RegExp) => within(dialog).getByLabelText(label);

async function pick(user: ReturnType<typeof setup>["user"], dialog: HTMLElement, name = "Linen Shirt") {
  await user.type(within(dialog).getByPlaceholderText(/Find a product: search by name or SKU/), "lin");
  const row = (await within(dialog).findByText(name)).closest("li")!;
  await user.click(within(row).getByRole("button", { name: /Add/ }));
}

describe("SupplierProductDialog", () => {
  describe("linking a product", () => {
    it("needs a product and a cost before saving", async () => {
      const { user, dialog } = setup();
      expect(dialog).toHaveAccessibleName("Link a product to Anvi Textiles");
      expect(field(dialog, /^Minimum order quantity/)).toHaveValue("1");
      await user.click(within(dialog).getByRole("button", { name: "Link product" }));
      expect(within(dialog).getByText("Choose a product.")).toBeInTheDocument();
      expect(within(dialog).getByText("Enter a cost above ₹0.")).toBeInTheDocument();
      expect(api.requests("POST", "/admin/suppliers/SUP001/products")).toHaveLength(0);
    });

    it("explains a bad MOQ and lead time", async () => {
      const { user, dialog } = setup();
      await user.clear(field(dialog, /^Minimum order quantity/));
      await user.type(field(dialog, /^Minimum order quantity/), "0");
      await user.type(field(dialog, /^Lead time/), "400");
      await user.click(within(dialog).getByRole("button", { name: "Link product" }));
      expect(within(dialog).getByText("The minimum order is a whole number, at least 1.")).toBeInTheDocument();
      expect(within(dialog).getByText("Lead time is a whole number of days from 0 to 365, or blank.")).toBeInTheDocument();
      await user.type(field(dialog, /^Lead time/), "{Backspace}");
      expect(within(dialog).queryByText(/Lead time is a whole number/)).not.toBeInTheDocument();
    });

    it("finds a product, won't offer one that's already linked, and links it", async () => {
      api.get("/admin/products", [pickable({ id: "PRD001", name: "Cotton Kurta Linen" }), pickable()]);
      api.post("/admin/suppliers/SUP001/products", (req) => supplierProduct({ id: 9, productId: req.body.productId, productName: "Linen Shirt" }));
      const { user, dialog, onSaved } = setup();

      await user.type(within(dialog).getByPlaceholderText(/Find a product/), "lin");
      const taken = (await within(dialog).findByText("Cotton Kurta Linen")).closest("li")!;
      expect(within(taken).getByRole("button", { name: /Added/ })).toBeDisabled();
      expect(api.last("GET", "/admin/products")!.query.get("search")).toBe("lin");

      const row = within(dialog).getByText("Linen Shirt").closest("li")!;
      await user.click(within(row).getByRole("button", { name: /Add/ }));
      expect(within(dialog).getByText("DCZ-ME0002")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Choose a different product than Linen Shirt" })).toBeInTheDocument();

      await user.type(field(dialog, /^Supplier's SKU/), " LS-1 ");
      await user.type(field(dialog, /^Purchase cost/), "650.5");
      await user.clear(field(dialog, /^Minimum order quantity/));
      await user.type(field(dialog, /^Minimum order quantity/), "12");
      await user.type(field(dialog, /^Lead time/), "5");
      await user.click(within(dialog).getByRole("checkbox", { name: /Preferred supplier/ }));
      await user.click(within(dialog).getByRole("button", { name: "Link product" }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(api.last("POST", "/admin/suppliers/SUP001/products")!.body).toEqual({
        productId: "PRD002",
        supplierSku: "LS-1",
        purchaseCost: 650.5,
        moq: 12,
        leadTimeDays: 5,
        status: "active",
        preferred: true,
        notes: "",
      });
      expect(toasts()).toContain("success:Linen Shirt linked to Anvi Textiles");
    });

    it("lets you change the chosen product", async () => {
      api.get("/admin/products", [pickable()]);
      const { user, dialog } = setup();
      await pick(user, dialog);
      await user.click(within(dialog).getByRole("button", { name: /Choose a different product/ }));
      expect(within(dialog).getByPlaceholderText(/Find a product/)).toBeInTheDocument();
    });

    it("puts an already-linked product error on the product", async () => {
      api.get("/admin/products", [pickable()]);
      api.post("/admin/suppliers/SUP001/products", fail(409, "Linen Shirt is already supplied by Anvi Textiles.", "SUPPLIER_PRODUCT_EXISTS"));
      const { user, dialog, onSaved } = setup();
      await pick(user, dialog);
      await user.type(field(dialog, /^Purchase cost/), "650");
      await user.click(within(dialog).getByRole("button", { name: "Link product" }));
      expect(await within(dialog).findByText("Linen Shirt is already supplied by Anvi Textiles.")).toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("shows a banner for an error that isn't about a field", async () => {
      api.get("/admin/products", [pickable()]);
      api.post("/admin/suppliers/SUP001/products", fail(500, "Something broke.", "INTERNAL"));
      const { user, dialog } = setup();
      await pick(user, dialog);
      await user.type(field(dialog, /^Purchase cost/), "650");
      await user.click(within(dialog).getByRole("button", { name: "Link product" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Something broke.");
    });
  });

  describe("editing a link", () => {
    it("prefills the link without a product picker and saves it", async () => {
      api.put("/admin/supplier-products/3", supplierProduct({ purchaseCost: 480 }));
      const { user, dialog, onSaved } = setup(supplierProduct());
      expect(dialog).toHaveAccessibleName("Edit Cotton Kurta");
      expect(within(dialog).queryByPlaceholderText(/Find a product/)).not.toBeInTheDocument();
      expect(field(dialog, /^Purchase cost/)).toHaveValue("450");
      expect(field(dialog, /^Minimum order quantity/)).toHaveValue("10");
      expect(field(dialog, /^Lead time/)).toHaveValue("7");
      expect(within(dialog).getByRole("checkbox", { name: /Preferred supplier/ })).toBeChecked();

      await user.clear(field(dialog, /^Purchase cost/));
      await user.type(field(dialog, /^Purchase cost/), "480");
      await user.selectOptions(field(dialog, /^Link status/), "inactive");
      await user.clear(field(dialog, /^Lead time/));
      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(api.last("PUT", "/admin/supplier-products/3")!.body).toEqual({
        supplierSku: "AT-K-01",
        purchaseCost: 480,
        moq: 10,
        leadTimeDays: null,
        status: "inactive",
        preferred: true,
        notes: "",
      });
      expect(toasts()).toContain("success:Supplier product updated");
    });

    it("shows a blank lead time for an unknown one", () => {
      const { dialog } = setup(supplierProduct({ leadTimeDays: null }));
      expect(field(dialog, /^Lead time/)).toHaveValue("");
    });

    it("closes on Cancel", async () => {
      const { user, dialog, onClose } = setup(supplierProduct());
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
