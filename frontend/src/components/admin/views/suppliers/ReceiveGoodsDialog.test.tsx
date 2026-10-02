import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PurchaseOrder } from "@/types/suppliers";
import { api, fail, networkError } from "@/test/api";
import { fireEvent, renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { poItem, purchaseOrder } from "@/test/suppliers-fixtures";
import { useToastStore } from "@/store/toastStore";

import { ReceiveGoodsDialog } from "./ReceiveGoodsDialog";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

const PO = purchaseOrder({
  status: "acknowledged",
  items: [
    poItem(),
    poItem({ id: 2, productId: "PRD002", name: "Linen Shirt", sku: "DCZ-ME0002", quantity: 10, receivedQty: 6, acceptedQty: 6, outstandingQty: 4 }),
  ],
});

function setup(po: PurchaseOrder = PO) {
  const onClose = vi.fn();
  const onReceived = vi.fn();
  const view = renderUI(<ReceiveGoodsDialog po={po} onClose={onClose} onReceived={onReceived} />);
  const dialog = screen.getByRole("dialog", { name: `Receive goods for ${po.poNumber}` });
  return { ...view, dialog, onClose, onReceived };
}

const qty = (dialog: HTMLElement, kind: "Received" | "Damaged" | "Rejected", name = "Cotton Kurta") => within(dialog).getByLabelText(`${kind} — ${name}`);
const row = (dialog: HTMLElement, name: string) => within(dialog).getByText(name, { selector: "span" }).closest("tr")!;
const record = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "Record delivery" });

describe("ReceiveGoodsDialog", () => {
  beforeEach(() => {
    // 06:00 UTC on the 2nd is mid-morning on the 2nd in the store's clock.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T06:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists each line with what's outstanding, dated today", () => {
    const { dialog } = setup();
    expect(row(dialog, "Cotton Kurta")).toHaveTextContent("50");
    expect(row(dialog, "Linen Shirt")).toHaveTextContent("4");
    const date = within(dialog).getByLabelText(/^Received on/);
    expect(date).toHaveValue("2026-10-02");
    expect(date).toHaveAttribute("max", "2026-10-02");
  });

  it("needs something received", async () => {
    const { user, dialog } = setup();
    await user.click(record(dialog));
    expect(within(dialog).getByText("Enter a received quantity for at least one line.")).toBeInTheDocument();
    expect(api.requests("POST", /\/receipts$/)).toHaveLength(0);
  });

  it("works out the accepted units as you type", async () => {
    const { user, dialog } = setup();
    const accepted = () => row(dialog, "Cotton Kurta").lastElementChild;
    expect(accepted()).toHaveTextContent("0");
    await user.type(qty(dialog, "Received"), "20");
    await user.type(qty(dialog, "Damaged"), "1");
    await user.type(qty(dialog, "Rejected"), "2");
    expect(accepted()).toHaveTextContent("17");
  });

  it("won't let damaged and rejected exceed what was received", async () => {
    const { user, dialog } = setup();
    await user.type(qty(dialog, "Received"), "10");
    await user.type(qty(dialog, "Damaged"), "6");
    await user.type(qty(dialog, "Rejected"), "5");
    await user.click(record(dialog));
    expect(within(row(dialog, "Cotton Kurta")).getByRole("alert")).toHaveTextContent("Damaged and rejected can't be more than received.");
    expect(qty(dialog, "Damaged")).toHaveAttribute("aria-invalid", "true");
    expect(row(dialog, "Cotton Kurta").lastElementChild).toHaveTextContent("0");
    expect(api.requests("POST", /\/receipts$/)).toHaveLength(0);

    // Changing the line clears its error.
    await user.clear(qty(dialog, "Rejected"));
    expect(within(row(dialog, "Cotton Kurta")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("allows damaged plus rejected equal to received", async () => {
    api.post("/admin/purchase-orders/POR001/receipts", PO);
    const { user, dialog, onReceived } = setup();
    await user.type(qty(dialog, "Received"), "10");
    await user.type(qty(dialog, "Damaged"), "4");
    await user.type(qty(dialog, "Rejected"), "6");
    await user.click(record(dialog));
    await waitFor(() => expect(onReceived).toHaveBeenCalled());
  });

  it("asks for whole numbers", async () => {
    const { user, dialog } = setup();
    await user.type(qty(dialog, "Received", "Linen Shirt"), "2.5");
    await user.type(qty(dialog, "Received"), "5");
    await user.click(record(dialog));
    expect(within(row(dialog, "Linen Shirt")).getByRole("alert")).toHaveTextContent("A whole number, 0 or more.");
  });

  it("refuses more than is outstanding until over-receipt is allowed with a reason", async () => {
    api.post("/admin/purchase-orders/POR001/receipts", PO);
    const { user, dialog, onReceived } = setup();
    await user.type(qty(dialog, "Received", "Linen Shirt"), "6");
    await user.click(record(dialog));
    expect(within(row(dialog, "Linen Shirt")).getByRole("alert")).toHaveTextContent("Only 4 outstanding. Tick “allow over-receipt” to accept more.");

    await user.click(within(dialog).getByRole("checkbox", { name: /Allow over-receipt/ }));
    expect(within(row(dialog, "Linen Shirt")).queryByRole("alert")).not.toBeInTheDocument();
    await user.click(record(dialog));
    expect(within(dialog).getByText("Say why more than ordered is being accepted.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText(/^Reason for over-receipt/), " Supplier sent extra ");
    await user.click(record(dialog));
    await waitFor(() => expect(onReceived).toHaveBeenCalled());
    const body = api.last("POST", "/admin/purchase-orders/POR001/receipts")!.body;
    expect(body.allowOverReceipt).toBe(true);
    expect(body.overReceiptReason).toBe("Supplier sent extra");
    expect(body.items).toEqual([{ poItemId: 2, receivedQty: 6, damagedQty: 0, rejectedQty: 0 }]);
  });

  it("refuses a received date in the future", async () => {
    const { user, dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText(/^Received on/), { target: { value: "2026-10-03" } });
    await user.type(qty(dialog, "Received"), "5");
    await user.click(record(dialog));
    expect(within(dialog).getByText("The received date can't be in the future.")).toBeInTheDocument();
  });

  it("records the delivery and hands back the updated order", async () => {
    signIn("admin", "adm");
    const updated = purchaseOrder({ status: "partially-received" });
    api.post("/admin/purchase-orders/POR001/receipts", updated);
    const { user, dialog, onReceived } = setup();
    await user.type(qty(dialog, "Received"), "20");
    await user.type(qty(dialog, "Damaged"), "1");
    await user.type(within(dialog).getByLabelText(/^Delivery notes/), " Challan 77 ");
    await user.click(record(dialog));

    await waitFor(() => expect(onReceived).toHaveBeenCalledWith(updated));
    const request = api.last("POST", "/admin/purchase-orders/POR001/receipts")!;
    expect(request.headers.authorization).toBe("Bearer adm");
    expect(request.body).toEqual({
      receivedAt: "2026-10-02",
      notes: "Challan 77",
      idempotencyKey: expect.any(String),
      items: [{ poItemId: 1, receivedQty: 20, damagedQty: 1, rejectedQty: 0 }],
      allowOverReceipt: false,
    });
    expect(toasts()).toContain("success:Delivery recorded. Accepted units were added to stock.");
  });

  it("sends the same idempotency key on a retry, so stock is never added twice", async () => {
    api.post("/admin/purchase-orders/POR001/receipts", PO);
    api.once("POST", "/admin/purchase-orders/POR001/receipts", networkError());
    const { user, dialog, onReceived } = setup();
    await user.type(qty(dialog, "Received"), "20");
    await user.click(record(dialog));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/couldn't connect just now/);
    expect(onReceived).not.toHaveBeenCalled();
    expect(record(dialog)).toBeEnabled();

    await user.click(record(dialog));
    await waitFor(() => expect(onReceived).toHaveBeenCalledTimes(1));
    const [first, second] = api.requests("POST", "/admin/purchase-orders/POR001/receipts").map((request) => request.body.idempotencyKey);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("sends one request for a double click, and locks the form meanwhile", async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.post("/admin/purchase-orders/POR001/receipts", () => new Promise((resolve) => (answer = resolve)));
    const { user, dialog, onReceived } = setup();
    await user.type(qty(dialog, "Received"), "20");
    await user.dblClick(record(dialog));
    expect(record(dialog)).toBeDisabled();
    expect(qty(dialog, "Received")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(api.requests("POST", "/admin/purchase-orders/POR001/receipts")).toHaveLength(1);
    answer(PO);
    await waitFor(() => expect(onReceived).toHaveBeenCalledTimes(1));
  });

  it("uses a new key for each opening", async () => {
    api.post("/admin/purchase-orders/POR001/receipts", PO);
    const first = setup();
    await first.user.type(qty(first.dialog, "Received"), "1");
    await first.user.click(record(first.dialog));
    await waitFor(() => expect(first.onReceived).toHaveBeenCalled());
    first.unmount();

    const second = setup();
    await second.user.type(qty(second.dialog, "Received"), "1");
    await second.user.click(record(second.dialog));
    await waitFor(() => expect(second.onReceived).toHaveBeenCalled());

    const keys = api.requests("POST", "/admin/purchase-orders/POR001/receipts").map((request) => request.body.idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("shows an over-receipt refusal from the server on the lines and as a banner", async () => {
    api.post("/admin/purchase-orders/POR001/receipts", fail(409, "Linen Shirt has only 4 outstanding.", "OVER_RECEIPT"));
    const { user, dialog, onReceived } = setup();
    await user.type(qty(dialog, "Received", "Linen Shirt"), "4");
    await user.click(record(dialog));
    await waitFor(() => expect(within(dialog).getAllByText("Linen Shirt has only 4 outstanding.")).toHaveLength(2));
    expect(onReceived).not.toHaveBeenCalled();
  });

  it("closes on Cancel", async () => {
    const { user, dialog, onClose } = setup();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
