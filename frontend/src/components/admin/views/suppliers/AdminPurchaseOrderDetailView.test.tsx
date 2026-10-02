import { describe, expect, it } from "vitest";

import type { PurchaseOrder } from "@/types/suppliers";
import { api, fail } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { page, poItem, purchaseOrder, supplier } from "@/test/suppliers-fixtures";
import { useToastStore } from "@/store/toastStore";

import { AdminPurchaseOrderDetailView } from "./AdminPurchaseOrderDetailView";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

const NONE: PurchaseOrder["actions"] = { edit: false, submit: false, send: false, acknowledge: false, receive: false, cancel: false };

async function open(po: PurchaseOrder = purchaseOrder()) {
  setLocation(`/admin/purchase-orders/detail?id=${po.id}`);
  api.get(`/admin/purchase-orders/${po.id}`, po);
  const view = renderUI(<AdminPurchaseOrderDetailView />);
  await screen.findByRole("heading", { name: po.poNumber, level: 1 });
  return view;
}

/** The header's action buttons. */
const headerButtons = () => within(screen.getByRole("heading", { level: 1 }).closest("header")!).queryAllByRole("button").map((button) => button.textContent);

const received = (overrides: Partial<PurchaseOrder> = {}) =>
  purchaseOrder({
    status: "partially-received",
    statusLabel: "Partially received",
    actions: { ...NONE, receive: true, cancel: true },
    items: [poItem({ receivedQty: 20, damagedQty: 1, rejectedQty: 0, acceptedQty: 19, outstandingQty: 30 })],
    receipts: [
      {
        id: 1,
        receiptNumber: "DCZ-GRN-2026-000001",
        receivedAt: "2026-10-03T09:00:00",
        notes: "Challan 77",
        createdBy: "ADM001",
        items: [{ poItemId: 1, productId: "PRD001", name: "Cotton Kurta", receivedQty: 20, damagedQty: 1, rejectedQty: 0, acceptedQty: 19, note: "One torn" }],
      },
    ],
    ...overrides,
  });

describe("AdminPurchaseOrderDetailView", () => {
  describe("loading and missing", () => {
    it("is not found without an id, and asks nothing", () => {
      renderUI(<AdminPurchaseOrderDetailView />);
      expect(screen.getByRole("heading", { name: "Purchase order not found" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to purchase orders" })).toHaveAttribute("href", "/admin/purchase-orders");
      expect(api.calls).toHaveLength(0);
    });

    it("shows a skeleton, then not-found on a 404", async () => {
      setLocation("/admin/purchase-orders/detail?id=POR404");
      api.get("/admin/purchase-orders/POR404", fail(404, "Not found", "NOT_FOUND"));
      renderUI(<AdminPurchaseOrderDetailView />);
      expect(screen.getByLabelText("Loading purchase order")).toBeInTheDocument();
      expect(await screen.findByRole("heading", { name: "Purchase order not found" })).toBeInTheDocument();
    });

    it("explains a missing purchasing permission", async () => {
      setLocation("/admin/purchase-orders/detail?id=POR001");
      api.get("/admin/purchase-orders/POR001", fail(403, "Forbidden", "FORBIDDEN"));
      renderUI(<AdminPurchaseOrderDetailView />);
      expect(await screen.findByText("Your role doesn't include purchasing")).toBeInTheDocument();
    });

    it("shows the API's message and retries", async () => {
      setLocation("/admin/purchase-orders/detail?id=POR001");
      api.get("/admin/purchase-orders/POR001", purchaseOrder());
      api.once("GET", "/admin/purchase-orders/POR001", fail(500, "Database busy.", "INTERNAL"));
      const { user } = renderUI(<AdminPurchaseOrderDetailView />);
      expect(await screen.findByRole("alert")).toHaveTextContent("Database busy.");
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("heading", { name: "DCZ-PO-2026-000001", level: 1 })).toBeInTheDocument();
    });
  });

  describe("what it shows", () => {
    it("shows the lines, totals, supplier and timeline from the API", async () => {
      signIn("admin", "adm");
      await open(purchaseOrder({ supplierReference: "", timeline: [{ status: "draft", note: "Raised for Diwali", actor: "ADM001", at: "2026-10-01T10:00:00" }] }));
      expect(api.last("GET", "/admin/purchase-orders/POR001")!.headers.authorization).toBe("Bearer adm");

      expect(screen.getByText("Anvi Textiles · raised 1 Oct 2026")).toBeInTheDocument();
      expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);

      const item = screen.getByRole("link", { name: "Cotton Kurta" }).closest("tr")!;
      expect(screen.getByRole("link", { name: "Cotton Kurta" })).toHaveAttribute("href", "/admin/products/edit?id=PRD001");
      expect(item).toHaveTextContent("DCZ-WO0001 · AT-K-01");
      expect(item).toHaveTextContent("5% · ₹1,125");
      expect(item).toHaveTextContent("₹23,625");

      const totals = screen.getByLabelText("Totals");
      expect(within(totals).getByText("CGST").nextSibling).toHaveTextContent("₹562.50");
      expect(within(totals).getByText("SGST").nextSibling).toHaveTextContent("₹562.50");
      expect(within(totals).queryByText("IGST")).not.toBeInTheDocument();
      expect(within(totals).getByText("Total").nextSibling).toHaveTextContent("₹23,625");
      expect(screen.getByText(/Intra-state supply: CGST \+ SGST./)).toBeInTheDocument();

      expect(screen.getByRole("link", { name: "Anvi Textiles" })).toHaveAttribute("href", "/admin/suppliers/detail?id=SUP001");
      expect(screen.getByText("Karnataka")).toBeInTheDocument();
      expect(screen.getByText("15 Oct 2026")).toBeInTheDocument();
      // A blank reference reads as a dash.
      expect(screen.getByText("Supplier reference").nextSibling).toHaveTextContent(/^—$/);
      expect(screen.getByText("Outstanding units").nextSibling).toHaveTextContent("50");

      const timeline = screen.getByRole("list", { name: "Timeline" });
      expect(timeline).toHaveTextContent(/ · ADM001/);
      expect(timeline).toHaveTextContent("Raised for Diwali");
    });

    it("never shows garbled characters", async () => {
      const { container } = await open(received({ actions: { ...NONE, receive: true } }));
      expect(container.textContent).not.toMatch(/Â|â€/);
    });

    it("shows IGST for an inter-state supplier", async () => {
      await open(purchaseOrder({ taxMode: "inter-state", cgst: 0, sgst: 0, igst: 1125 }));
      const totals = screen.getByLabelText("Totals");
      expect(within(totals).getByText("IGST").nextSibling).toHaveTextContent("₹1,125");
      expect(within(totals).queryByText("CGST")).not.toBeInTheDocument();
      expect(screen.getByText(/Inter-state supply: IGST./)).toBeInTheDocument();
    });

    it("says there's no GST for a supplier that charges none", async () => {
      await open(purchaseOrder({ taxTotal: 0, cgst: 0, sgst: 0, total: 22500 }));
      expect(screen.getByText("No GST for this supplier")).toBeInTheDocument();
    });

    it("flags a supplier that is no longer active", async () => {
      await open(purchaseOrder({ supplier: { ...purchaseOrder().supplier, status: "inactive" } }));
      expect(screen.getByText("Supplier status").nextSibling).toHaveTextContent("Inactive");
    });

    it("shows each receipt with its lines", async () => {
      await open(received());
      const receipt = screen.getByText("DCZ-GRN-2026-000001").closest("li")!;
      expect(receipt).toHaveTextContent("3 Oct 2026 · ADM001");
      expect(receipt).toHaveTextContent("One torn");
      expect(receipt).toHaveTextContent("Challan 77");
      const row = within(receipt).getAllByRole("row")[1]!;
      expect(within(row).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["Cotton KurtaOne torn", "20", "1", "0", "19"]);
    });

    it("says nothing's been received, pointing at Receive goods when it's allowed", async () => {
      await open(purchaseOrder({ status: "sent", actions: { ...NONE, receive: true } }));
      expect(screen.getByText("Nothing received yet. Use “Receive goods” when the delivery arrives.")).toBeInTheDocument();
    });

    it("says only that nothing's been received when receiving isn't allowed", async () => {
      await open();
      expect(screen.getByText("Nothing received yet.")).toBeInTheDocument();
    });

    it("shows the server's warnings", async () => {
      await open(purchaseOrder({ warnings: ["Cotton Kurta is below its MOQ."] }));
      expect(screen.getByRole("status")).toHaveTextContent("Cotton Kurta is below its MOQ.");
    });
  });

  describe("actions are the server's decision", () => {
    it("offers a draft's edit, submit and cancel", async () => {
      await open();
      expect(headerButtons()).toEqual(["Edit", "Submit", "Cancel order"]);
    });

    it("offers nothing when nothing is allowed", async () => {
      await open(purchaseOrder({ status: "received", actions: NONE }));
      expect(headerButtons()).toEqual([]);
    });

    it.each([
      ["edit", "Edit"],
      ["submit", "Submit"],
      ["send", "Mark sent"],
      ["acknowledge", "Mark acknowledged"],
      ["receive", "Receive goods"],
      ["cancel", "Cancel order"],
    ] as const)("shows only %s when only it is allowed", async (key, label) => {
      await open(purchaseOrder({ actions: { ...NONE, [key]: true } }));
      expect(headerButtons()).toEqual([label]);
    });

    it("treats missing actions as none", async () => {
      await open(purchaseOrder({ actions: undefined as unknown as PurchaseOrder["actions"] }));
      expect(headerButtons()).toEqual([]);
    });
  });

  describe("moving the order on", () => {
    it("asks before submitting, then shows the submitted order", async () => {
      const { user } = await open();
      api.post("/admin/purchase-orders/POR001/submit", purchaseOrder({ status: "submitted", statusLabel: "Submitted", actions: { ...NONE, send: true, cancel: true } }));
      await user.click(screen.getByRole("button", { name: "Submit" }));
      const dialog = await screen.findByRole("dialog", { name: "Submit DCZ-PO-2026-000001?" });
      expect(dialog).toHaveTextContent("It can no longer be edited once submitted.");
      await user.click(within(dialog).getByRole("button", { name: "Submit" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.last("POST", "/admin/purchase-orders/POR001/submit")!.body).toEqual({});
      expect(toasts()).toContain("success:Purchase order submitted");
      expect(headerButtons()).toEqual(["Mark sent", "Cancel order"]);
      expect(screen.getAllByText("Submitted").length).toBeGreaterThan(0);
    });

    it("doesn't submit when the confirmation is dismissed", async () => {
      const { user } = await open();
      await user.click(screen.getByRole("button", { name: "Submit" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.requests("POST", /\/submit$/)).toHaveLength(0);
    });

    it("records an acknowledgement straight away", async () => {
      const { user } = await open(purchaseOrder({ status: "sent", actions: { ...NONE, acknowledge: true } }));
      api.post("/admin/purchase-orders/POR001/acknowledge", purchaseOrder({ status: "acknowledged", actions: { ...NONE, receive: true } }));
      await user.click(screen.getByRole("button", { name: "Mark acknowledged" }));
      await waitFor(() => expect(toasts()).toContain("success:Supplier acknowledgement recorded"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(headerButtons()).toEqual(["Receive goods"]);
    });

    it("shows the API's message when a step fails", async () => {
      const { user } = await open(purchaseOrder({ actions: { ...NONE, send: true } }));
      api.post("/admin/purchase-orders/POR001/send", fail(409, "Submit it first.", "INVALID_TRANSITION"));
      await user.click(screen.getByRole("button", { name: "Mark sent" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Mark sent" }));
      await waitFor(() => expect(toasts()).toContain("error:Submit it first."));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(headerButtons()).toEqual(["Mark sent"]);
    });
  });

  describe("cancelling", () => {
    it("asks for a reason, then cancels", async () => {
      const { user } = await open();
      api.post("/admin/purchase-orders/POR001/cancel", purchaseOrder({ status: "cancelled", statusLabel: "Cancelled", actions: NONE }));
      await user.click(screen.getByRole("button", { name: "Cancel order" }));
      const dialog = await screen.findByRole("dialog", { name: "Cancel DCZ-PO-2026-000001?" });
      expect(dialog).toHaveTextContent("This can’t be undone.");

      await user.click(within(dialog).getByRole("button", { name: "Cancel order" }));
      expect(within(dialog).getByText("Say why this order is being cancelled.")).toBeInTheDocument();
      expect(api.requests("POST", "/admin/purchase-orders/POR001/cancel")).toHaveLength(0);

      await user.type(within(dialog).getByLabelText(/^Reason/), "  Supplier out of stock ");
      expect(within(dialog).queryByText("Say why this order is being cancelled.")).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Cancel order" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.last("POST", "/admin/purchase-orders/POR001/cancel")!.body).toEqual({ reason: "Supplier out of stock" });
      expect(toasts()).toContain("success:Purchase order cancelled");
      expect(headerButtons()).toEqual([]);
      expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
    });

    it("keeps the order on Keep order", async () => {
      const { user } = await open();
      await user.click(screen.getByRole("button", { name: "Cancel order" }));
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Keep order" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.requests("POST", /\/cancel$/)).toHaveLength(0);
    });

    it("stays open with the API's message when cancelling fails", async () => {
      const { user } = await open();
      api.post("/admin/purchase-orders/POR001/cancel", fail(409, "Goods have already been received.", "PO_NOT_CANCELLABLE"));
      await user.click(screen.getByRole("button", { name: "Cancel order" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText(/^Reason/), "Changed our mind");
      await user.click(within(dialog).getByRole("button", { name: "Cancel order" }));
      expect(await within(dialog).findByText("Goods have already been received.")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Cancel order" })).toBeEnabled();
    });
  });

  describe("editing and receiving", () => {
    it("edits the draft in place and shows the saved order", async () => {
      const { user } = await open();
      api.get("/admin/suppliers", page([supplier()]));
      api.get("/admin/suppliers/SUP001/products", []);
      api.put("/admin/purchase-orders/POR001", purchaseOrder({ items: [poItem({ quantity: 60, lineTotal: 28350 })], total: 28350 }));
      await user.click(screen.getByRole("button", { name: "Edit" }));

      const form = await screen.findByRole("form", { name: "Edit DCZ-PO-2026-000001" });
      await user.clear(within(form).getByLabelText("Quantity of Cotton Kurta"));
      await user.type(within(form).getByLabelText("Quantity of Cotton Kurta"), "60");
      await user.click(within(form).getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(screen.queryByRole("form")).not.toBeInTheDocument());
      expect(screen.getByRole("link", { name: "Cotton Kurta" }).closest("tr")).toHaveTextContent("60");
      expect(within(screen.getByLabelText("Totals")).getByText("Total").nextSibling).toHaveTextContent("₹28,350");
    });

    it("leaves editing on Cancel", async () => {
      const { user } = await open();
      api.get("/admin/suppliers", page([supplier()]));
      api.get("/admin/suppliers/SUP001/products", []);
      await user.click(screen.getByRole("button", { name: "Edit" }));
      await user.click(within(await screen.findByRole("form")).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("form")).not.toBeInTheDocument();
      expect(headerButtons()).toEqual(["Edit", "Submit", "Cancel order"]);
    });

    it("records a delivery from the receive dialog and shows the updated order", async () => {
      const { user } = await open(purchaseOrder({ status: "acknowledged", actions: { ...NONE, receive: true } }));
      api.post("/admin/purchase-orders/POR001/receipts", received());
      await user.click(screen.getByRole("button", { name: "Receive goods" }));
      const dialog = await screen.findByRole("dialog", { name: "Receive goods for DCZ-PO-2026-000001" });
      await user.type(within(dialog).getByLabelText("Received — Cotton Kurta"), "20");
      await user.click(within(dialog).getByRole("button", { name: "Record delivery" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.getByText("DCZ-GRN-2026-000001")).toBeInTheDocument();
      expect(screen.getByText("Outstanding units").nextSibling).toHaveTextContent("30");
    });
  });
});
