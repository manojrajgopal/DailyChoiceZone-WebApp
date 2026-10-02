import { describe, expect, it } from "vitest";

import type { SupplierDetail } from "@/types/suppliers";
import { api, fail } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { page, poListItem, supplierDetail, supplierProduct } from "@/test/suppliers-fixtures";
import { useToastStore } from "@/store/toastStore";

import { AdminSupplierDetailView } from "./AdminSupplierDetailView";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

async function open(detail: SupplierDetail = supplierDetail(), links = [supplierProduct()]) {
  setLocation(`/admin/suppliers/detail?id=${detail.id}`);
  api.get(`/admin/suppliers/${detail.id}`, detail);
  api.get(`/admin/suppliers/${detail.id}/products`, links);
  const view = renderUI(<AdminSupplierDetailView />);
  await screen.findByRole("heading", { name: detail.name, level: 1 });
  return view;
}

const stats = () => screen.getByRole("region", { name: "Supplier statistics" });
/** A stat tile's value, found by its label. */
const tile = (label: string) => within(stats()).getByText(label).parentElement!;

describe("AdminSupplierDetailView", () => {
  describe("loading and missing", () => {
    it("is not found without an id, and asks nothing", () => {
      renderUI(<AdminSupplierDetailView />);
      expect(screen.getByRole("heading", { name: "Supplier not found" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to suppliers" })).toHaveAttribute("href", "/admin/suppliers");
      expect(api.calls).toHaveLength(0);
    });

    it("shows a skeleton, then not-found on a 404", async () => {
      setLocation("/admin/suppliers/detail?id=SUP404");
      api.get("/admin/suppliers/SUP404", fail(404, "Not found", "NOT_FOUND"));
      renderUI(<AdminSupplierDetailView />);
      expect(screen.getByLabelText("Loading supplier")).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "Supplier not found" })).toBeInTheDocument();
    });

    it("explains a missing permission", async () => {
      setLocation("/admin/suppliers/detail?id=SUP001");
      api.get("/admin/suppliers/SUP001", fail(403, "Forbidden", "FORBIDDEN"));
      renderUI(<AdminSupplierDetailView />);
      expect(await screen.findByText("Your role doesn't include suppliers")).toBeInTheDocument();
    });

    it("shows the API's message and retries", async () => {
      setLocation("/admin/suppliers/detail?id=SUP001");
      api.get("/admin/suppliers/SUP001", supplierDetail());
      api.get("/admin/suppliers/SUP001/products", []);
      api.once("GET", "/admin/suppliers/SUP001", fail(500, "Database busy.", "INTERNAL"));
      const { user } = renderUI(<AdminSupplierDetailView />);
      expect(await screen.findByRole("alert")).toHaveTextContent("Database busy.");
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("heading", { name: "Anvi Textiles", level: 1 })).toBeInTheDocument();
    });
  });

  describe("the supplier", () => {
    it("shows the header, stats and details from the API", async () => {
      signIn("admin", "adm");
      await open();
      expect(api.last("GET", "/admin/suppliers/SUP001")!.headers.authorization).toBe("Bearer adm");
      expect(screen.getByText("ANVI-TEX · Anvi Textiles Pvt Ltd")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute("href", "/admin/suppliers/edit?id=SUP001");
      expect(screen.getByRole("link", { name: "New purchase order" })).toHaveAttribute("href", "/admin/purchase-orders/new?supplier=SUP001");

      expect(tile("Products")).toHaveTextContent("43 active");
      expect(tile("Purchase orders")).toHaveTextContent("62 open");
      expect(tile("Total purchased")).toHaveTextContent("₹1,25,000");
      expect(tile("Outstanding units")).toHaveTextContent("30");
      expect(tile("Average lead time")).toHaveTextContent("6.5 days");
      expect(tile("On time")).toHaveTextContent("75%");

      expect(screen.getByText("Registered")).toBeInTheDocument();
      expect(screen.getByText("Same as billing")).toBeInTheDocument();
      expect(screen.getByText("Net 30 · 30 credit days")).toBeInTheDocument();
      expect(screen.getByText("12 Mill Road, Bengaluru, Karnataka, 560001, India")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "sales@anvi.example" })).toHaveAttribute("href", "mailto:sales@anvi.example");
    });

    it("says when there isn't enough history for lead time and on-time rate", async () => {
      await open(supplierDetail({ stats: { ...supplierDetail().stats, averageLeadTimeDays: null, onTimeRate: null } }));
      expect(tile("Average lead time")).toHaveTextContent("—Not enough history yet");
      expect(tile("On time")).toHaveTextContent("—Not enough history yet");
    });

    it("offers marking inactive and archiving for an active supplier", async () => {
      await open();
      expect(screen.getByRole("button", { name: "Mark inactive" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
    });

    it("offers activating, and no new PO, for an inactive supplier", async () => {
      await open(supplierDetail({ status: "inactive" }));
      expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "New purchase order" })).not.toBeInTheDocument();
    });

    it("offers only activating for an archived supplier, and no linking", async () => {
      await open(supplierDetail({ status: "archived" }), []);
      expect(screen.getByRole("button", { name: "Activate" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
      expect(await screen.findByText("This supplier is archived.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Link a product/ })).not.toBeInTheDocument();
    });
  });

  describe("changing the status", () => {
    it("asks before archiving, then archives and re-reads the supplier", async () => {
      const { user } = await open();
      api.post("/admin/suppliers/SUP001/status", supplierDetail({ status: "archived" }));
      await user.click(screen.getByRole("button", { name: "Archive" }));
      const dialog = await screen.findByRole("dialog", { name: "Archive Anvi Textiles?" });
      expect(dialog).toHaveTextContent(/disappears from the supplier list/);

      api.get("/admin/suppliers/SUP001", supplierDetail({ status: "archived" }));
      await user.click(within(dialog).getByRole("button", { name: "Archive" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.last("POST", "/admin/suppliers/SUP001/status")!.body).toEqual({ status: "archived" });
      expect(toasts()).toContain("success:Supplier archived");
      expect(await screen.findByRole("button", { name: "Activate" })).toBeInTheDocument();
    });

    it("changes nothing when the confirmation is dismissed", async () => {
      const { user } = await open();
      await user.click(screen.getByRole("button", { name: "Mark inactive" }));
      const dialog = await screen.findByRole("dialog", { name: "Mark inactive Anvi Textiles?" });
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.requests("POST", "/admin/suppliers/SUP001/status")).toHaveLength(0);
    });

    it("activates an inactive supplier", async () => {
      const { user } = await open(supplierDetail({ status: "inactive" }));
      api.post("/admin/suppliers/SUP001/status", supplierDetail());
      await user.click(screen.getByRole("button", { name: "Activate" }));
      await user.click(within(await screen.findByRole("dialog", { name: "Activate Anvi Textiles?" })).getByRole("button", { name: "Activate" }));
      await waitFor(() => expect(toasts()).toContain("success:Supplier activated"));
      expect(api.last("POST", "/admin/suppliers/SUP001/status")!.body).toEqual({ status: "active" });
    });

    it("shows the API's message when it fails", async () => {
      const { user } = await open();
      api.post("/admin/suppliers/SUP001/status", fail(409, "It has open purchase orders.", "SUPPLIER_HAS_OPEN_POS"));
      await user.click(screen.getByRole("button", { name: "Mark inactive" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Mark inactive" }));
      await waitFor(() => expect(toasts()).toContain("error:It has open purchase orders."));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("products tab", () => {
    it("lists the linked products with cost, MOQ, lead time and flags", async () => {
      await open(supplierDetail(), [
        supplierProduct(),
        supplierProduct({ id: 4, productId: "PRD002", productName: "Linen Shirt", productSku: "DCZ-ME0002", productStatus: "out-of-stock", supplierSku: "", purchaseCost: 99.5, moq: 1, leadTimeDays: null, status: "inactive", preferred: false }),
      ]);
      expect(screen.getByRole("tab", { name: "Products" })).toHaveAttribute("aria-selected", "true");
      const panel = screen.getByRole("tabpanel");
      expect(await within(panel).findByRole("link", { name: "Cotton Kurta" })).toHaveAttribute("href", "/admin/products/edit?id=PRD001");
      const rows = within(panel).getAllByRole("row");
      expect(rows[1]).toHaveTextContent("AT-K-01");
      expect(rows[1]).toHaveTextContent("₹450");
      expect(rows[1]).toHaveTextContent("7 d");
      expect(rows[1]).toHaveTextContent("Preferred");
      expect(rows[2]).toHaveTextContent("DCZ-ME0002 · Out of stock");
      expect(rows[2]).toHaveTextContent("₹99.50");
      expect(rows[2]).toHaveTextContent("Inactive");
      expect(rows[2]).not.toHaveTextContent("Preferred");
      expect(within(rows[2]!).getAllByText("—")).toHaveLength(2);
    });

    it("says when nothing is linked yet", async () => {
      await open(supplierDetail(), []);
      expect(await screen.findByText("No products linked yet")).toBeInTheDocument();
    });

    it("asks before removing a link, then removes it and re-reads", async () => {
      const { user } = await open();
      api.delete("/admin/supplier-products/3", {});
      await user.click(await screen.findByRole("button", { name: "Remove Cotton Kurta" }));
      const dialog = await screen.findByRole("dialog", { name: "Remove Cotton Kurta?" });
      api.get("/admin/suppliers/SUP001/products", []);
      await user.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.requests("DELETE", "/admin/supplier-products/3")).toHaveLength(1);
      expect(toasts()).toContain("success:Cotton Kurta removed from Anvi Textiles");
      expect(await screen.findByText("No products linked yet")).toBeInTheDocument();
      expect(api.requests("GET", "/admin/suppliers/SUP001")).toHaveLength(2);
    });

    it("keeps the link when removing fails", async () => {
      const { user } = await open();
      api.delete("/admin/supplier-products/3", fail(409, "It's on an open purchase order.", "IN_USE"));
      await user.click(await screen.findByRole("button", { name: "Remove Cotton Kurta" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(toasts()).toContain("error:It's on an open purchase order."));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("opens the link dialog to add or edit", async () => {
      const { user } = await open();
      await user.click(screen.getByRole("button", { name: /Link a product/ }));
      expect(await screen.findByRole("dialog", { name: "Link a product to Anvi Textiles" })).toBeInTheDocument();
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Edit Cotton Kurta" }));
      expect(await screen.findByRole("dialog", { name: "Edit Cotton Kurta" })).toBeInTheDocument();
    });
  });

  describe("other tabs", () => {
    it("lists the supplier's purchase orders", async () => {
      const { user } = await open();
      api.get("/admin/purchase-orders", page([poListItem()], { total: 30 }));
      await user.click(screen.getByRole("tab", { name: "Purchase orders" }));
      const panel = screen.getByRole("tabpanel");
      expect(await within(panel).findByRole("link", { name: "DCZ-PO-2026-000001" })).toHaveAttribute("href", "/admin/purchase-orders/detail?id=POR001");
      expect(panel).toHaveTextContent("The latest 1 of 30.");
      expect(within(panel).getByRole("link", { name: "View all" })).toHaveAttribute("href", "/admin/purchase-orders?supplier=SUP001");
      expect(api.last("GET", "/admin/purchase-orders")!.query.get("supplier")).toBe("SUP001");
    });

    it("explains a missing purchasing permission on the purchase orders tab", async () => {
      const { user } = await open();
      api.get("/admin/purchase-orders", fail(403, "Forbidden", "FORBIDDEN"));
      await user.click(screen.getByRole("tab", { name: "Purchase orders" }));
      expect(await screen.findByText("Your role doesn't include purchasing")).toBeInTheDocument();
    });

    it("shows recent deliveries with received and accepted units", async () => {
      const { user } = await open();
      await user.click(screen.getByRole("tab", { name: "Recent deliveries" }));
      const panel = screen.getByRole("tabpanel");
      expect(panel).toHaveTextContent("DCZ-GRN-2026-000001");
      expect(panel).toHaveTextContent("1 line · 20 received · 19 accepted");
      expect(panel).toHaveTextContent("20 Sept 2026");
    });

    it("says when nothing has been received", async () => {
      const { user } = await open(supplierDetail({ recentDeliveries: [], history: [] }));
      await user.click(screen.getByRole("tab", { name: "Recent deliveries" }));
      expect(screen.getByText("Nothing received from this supplier yet.")).toBeInTheDocument();
      await user.click(screen.getByRole("tab", { name: "History" }));
      expect(screen.getByText("No history yet.")).toBeInTheDocument();
    });

    it("shows the history with who did what", async () => {
      const { user } = await open(
        supplierDetail({ history: [...supplierDetail().history, { at: "2026-09-01T10:00:00", action: "supplier.create", summary: "", actor: "" }] }),
      );
      await user.click(screen.getByRole("tab", { name: "History" }));
      expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
      const panel = screen.getByRole("tabpanel");
      expect(panel).toHaveTextContent("Payment terms changed to Net 30");
      expect(panel).toHaveTextContent("ADM001");
      expect(panel).toHaveTextContent("Supplier.create");
    });
  });
});
