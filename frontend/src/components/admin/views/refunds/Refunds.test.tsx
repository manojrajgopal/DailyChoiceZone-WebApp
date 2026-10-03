import { describe, expect, it } from "vitest";

import { OrderRefunds } from "@/components/account/OrderRefunds";
import { api, fail } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { useToastStore } from "@/store/toastStore";
import type { RefundBreakdown, RefundBreakdownLine, RefundRecord } from "@/types/refunds";

import { AdminRefundsQueueView } from "./AdminRefundsQueueView";
import { OrderRefundsCard } from "./OrderRefundsCard";
import { RefundSettingsPanel } from "./RefundSettingsPanel";
import { rupeesToPaise } from "./RefundWizard";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

function line(patch: Partial<RefundBreakdownLine> = {}): RefundBreakdownLine {
  return {
    orderItemId: 501, invoiceItemId: 9001, productId: "P1", name: "Cotton Kurta", sku: "KUR-M", image: "", size: "M",
    color: "Blue", hsn: "6204", ordered: 2, cancelled: 0, returned: 0, refunded: 0, refundable: 2, unitPrice: 124900,
    lineTotal: 249800, lineDiscount: 0, lineTax: 11895, taxRatePercent: 5, remainingAmount: 249800, quantity: 0,
    gross: 0, discount: 0, amount: 0, taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0,
    ...patch,
  };
}

function breakdown(patch: Partial<RefundBreakdown> = {}): RefundBreakdown {
  const totals = { items: 0, gross: 0, discount: 0, shipping: 0, adjustment: 0, taxable: 0, tax: 0, cgst: 0, sgst: 0,
    igst: 0, total: 0 };
  return {
    orderId: "ORD042", orderNumber: "DCZ10042", orderStatus: "delivered", invoiceId: "INV1", invoiceNumber: "INV-1",
    currency: "INR", paymentMethod: "upi", paymentStatus: "captured", isCod: false, taxMode: "inclusive",
    paid: { total: 259700, payment: 259700, tenders: 0, grandTotal: 259700 }, refunded: 0, remaining: 259700,
    remainingByDestination: { payment: 259700, tenders: 0 },
    lines: [line()], shipping: { charged: 9900, refunded: 0, refundable: 9900, amount: 0 }, adjustment: 0,
    totals, split: { payment: 0, tenders: 0 }, fullRefund: false, suggestShipping: false, method: "original",
    allowedMethods: ["original", "store-credit"], approvalThreshold: 1000000, requiresApproval: false,
    reasonCodes: [{ code: "damaged", label: "Arrived damaged" }, { code: "other", label: "Other" }],
    ...patch,
  };
}

function record(patch: Partial<RefundRecord> = {}): RefundRecord {
  return {
    id: "RF1", refundNumber: "DCZ-RF-0001", orderId: "ORD042", orderNumber: "DCZ10042", invoiceId: "INV1",
    invoiceNumber: "INV-1", paymentId: "PAY1", customerId: "C1", customerName: "Asha Rao", amount: 124900,
    paymentAmount: 124900, tenderAmount: 0, shippingAmount: 0, taxAmount: 5948, discountAmount: 0, method: "original",
    methodLabel: "Original payment method", reasonCode: "damaged", reasonLabel: "Arrived damaged", reason: "",
    internalNote: "", status: "completed", statusLabel: "Completed", requiresApproval: false, approvedBy: null,
    approvedAt: null, initiatedBy: "A1", gatewayReference: "rfnd_1", manualReference: "", failureReason: "",
    attempts: 1, lastAttemptAt: null, nextCheckAt: null, creditNoteId: null, requestedAt: "2026-10-01T10:00:00",
    processedAt: "2026-10-01T10:00:05", canApprove: false, canRetry: false, canCancel: false,
    items: [{ orderItemId: 501, invoiceItemId: 9001, productId: "P1", name: "Cotton Kurta", quantity: 1, amount: 124900,
      discount: 0, taxable: 118952, taxRatePercent: 5, cgst: 2974, sgst: 2974, igst: 0, tax: 5948 }],
    ...patch,
  };
}

describe("rupeesToPaise", () => {
  it("reads rupees as whole paise without floating point", () => {
    expect(rupeesToPaise("120")).toBe(12000);
    expect(rupeesToPaise("120.5")).toBe(12050);
    expect(rupeesToPaise("0.07")).toBe(7);
    expect(rupeesToPaise("1,299.99")).toBe(129999);
    expect(rupeesToPaise("")).toBe(0);
    expect(rupeesToPaise("12.345")).toBeNull();
    expect(rupeesToPaise("-5")).toBeNull();
    expect(rupeesToPaise("abc")).toBeNull();
  });
});

describe("OrderRefundsCard", () => {
  it("lists the order's refunds with what's left, using the admin token", async () => {
    signIn("admin", "adm");
    api.get("/admin/refunds/orders/ORD042", { breakdown: breakdown({ refunded: 124900, remaining: 134800 }), refunds: [record()] });
    renderUI(<OrderRefundsCard orderId="ORD042" />);
    expect(await screen.findByText("DCZ-RF-0001")).toBeInTheDocument();
    expect(screen.getByText("1 × Cotton Kurta")).toBeInTheDocument();
    expect(screen.getByText(/₹1,348\.00 of ₹2,597\.00 left to refund/)).toBeInTheDocument();
    expect(api.last("GET", "/admin/refunds/orders/ORD042")!.headers.authorization).toBe("Bearer adm");
  });

  it("is hidden without the refunds permission", async () => {
    api.get("/admin/refunds/orders/ORD042", fail(403, "Forbidden", "FORBIDDEN"));
    const { container } = renderUI(<OrderRefundsCard orderId="ORD042" />);
    await waitFor(() => expect(api.requests("GET", "/admin/refunds/orders/ORD042")).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("approves a refund waiting for approval and reads the order again", async () => {
    const waiting = record({ status: "requested", statusLabel: "Requested", requiresApproval: true, canApprove: true,
      canCancel: true });
    api.get("/admin/refunds/orders/ORD042", { breakdown: breakdown(), refunds: [waiting] });
    api.post("/admin/refunds/RF1/approve", record());
    let changed = 0;
    const { user } = renderUI(<OrderRefundsCard orderId="ORD042" onChanged={() => { changed += 1; }} />);
    expect(await screen.findByText("Waiting for a manager to approve it.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(toasts()).toContain("success:DCZ-RF-0001 approved."));
    expect(changed).toBe(1);
    expect(api.requests("GET", "/admin/refunds/orders/ORD042").length).toBeGreaterThan(1);
  });

  it("rejects one with a note", async () => {
    api.get("/admin/refunds/orders/ORD042", { breakdown: breakdown(), refunds: [record({ status: "requested",
      statusLabel: "Requested", canApprove: true })] });
    api.post("/admin/refunds/RF1/reject", record({ status: "rejected", statusLabel: "Rejected" }));
    const { user } = renderUI(<OrderRefundsCard orderId="ORD042" />);
    await user.click(await screen.findByRole("button", { name: "Reject…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject DCZ-RF-0001?" });
    await user.type(within(dialog).getByLabelText("Note"), "Customer kept the item");
    await user.click(within(dialog).getByRole("button", { name: "Reject refund" }));
    await waitFor(() => expect(api.last("POST", "/admin/refunds/RF1/reject")?.body).toEqual({ note: "Customer kept the item" }));
  });

  it("retries a failed refund and shows the gateway's reason", async () => {
    api.get("/admin/refunds/orders/ORD042", { breakdown: breakdown(), refunds: [record({ status: "failed",
      statusLabel: "Failed", failureReason: "Gateway timeout", canRetry: true, canCancel: true })] });
    api.post("/admin/refunds/RF1/retry", record());
    const { user } = renderUI(<OrderRefundsCard orderId="ORD042" />);
    expect(await screen.findByText("Gateway timeout (attempt 1)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(toasts()).toContain("success:DCZ-RF-0001 completed."));
  });
});

describe("RefundWizard", () => {
  async function openWizard(initial = breakdown()) {
    api.get("/admin/refunds/orders/ORD042", { breakdown: initial, refunds: [] });
    api.post("/admin/refunds/orders/ORD042/calculate", (req) => {
      const units = req.body.lines?.[0]?.quantity ?? 0;
      const shipping = req.body.includeShipping ? req.body.shippingAmount : 0;
      const adjustment = req.body.adjustmentAmount ?? 0;
      const items = units * 124900;
      return breakdown({
        lines: [line({ quantity: units, amount: items, tax: units * 5948 })],
        totals: { items, gross: items, discount: 0, shipping, adjustment, taxable: 0, tax: units * 5948, cgst: 0, sgst: 0,
          igst: 0, total: items + shipping + adjustment },
        requiresApproval: items + shipping + adjustment > 200000,
      });
    });
    const view = renderUI(<OrderRefundsCard orderId="ORD042" />);
    await view.user.click(await screen.findByRole("button", { name: /Refund items/ }));
    const dialog = await screen.findByRole("dialog", { name: "Refund order #DCZ10042" });
    return { ...view, dialog };
  }

  it("shows the server's figures for the chosen items and raises the refund once, with a key", async () => {
    const { user, dialog } = await openWizard();
    api.post("/admin/refunds/orders/ORD042", record());
    const units = within(dialog).getByLabelText("Units of Cotton Kurta to refund");
    await user.clear(units);
    await user.type(units, "1");
    await waitFor(() => expect(within(dialog).getByTestId("refund-total")).toHaveTextContent("₹1,249.00"));
    expect(api.last("POST", "/admin/refunds/orders/ORD042/calculate")?.body).toEqual({
      lines: [{ orderItemId: 501, quantity: 1 }], method: "original",
    });

    const submit = within(dialog).getByRole("button", { name: /^Refund ₹1,249\.00/ });
    expect(submit).toBeDisabled(); // no reason yet
    await user.selectOptions(within(dialog).getByLabelText(/^Reason/), "damaged");
    await user.click(submit);
    await waitFor(() => expect(api.requests("POST", "/admin/refunds/orders/ORD042")).toHaveLength(1));
    const body = api.last("POST", "/admin/refunds/orders/ORD042")!.body;
    expect(body).toMatchObject({ lines: [{ orderItemId: 501, quantity: 1 }], method: "original", reasonCode: "damaged" });
    expect(body.idempotencyKey).toMatch(/.{8,}/);
    // No amount is sent: the server works it out.
    expect(body.amount).toBeUndefined();
    expect(toasts()).toContain("success:₹1,249.00 refunded — DCZ-RF-0001");
  });

  it("refunds everything left, delivery included, in paise", async () => {
    const { user, dialog } = await openWizard();
    await user.click(within(dialog).getByRole("button", { name: "Refund everything left" }));
    await waitFor(() => expect(api.last("POST", "/admin/refunds/orders/ORD042/calculate")?.body).toEqual({
      lines: [{ orderItemId: 501, quantity: 2 }], includeShipping: true, shippingAmount: 9900, method: "original",
    }));
    await waitFor(() => expect(within(dialog).getByTestId("refund-total")).toHaveTextContent("₹2,597.00"));
    expect(within(dialog).getByText(/sent once a manager approves it/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Request refund/ })).toBeInTheDocument();
  });

  it("shows the server's refusal and won't raise it", async () => {
    const { user, dialog } = await openWizard();
    api.post("/admin/refunds/orders/ORD042/calculate", fail(409, "That is more than is left to refund on this order (₹2,597.00).",
      "REFUND_EXCEEDS_PAYMENT"));
    await user.type(within(dialog).getByLabelText(/Extra amount/), "9999");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("more than is left to refund");
    await user.selectOptions(within(dialog).getByLabelText(/^Reason/), "other");
    expect(within(dialog).getByRole("button", { name: /^Refunds*$/ })).toBeDisabled();
  });

  it("checks a typed amount before asking", async () => {
    const { user, dialog } = await openWizard();
    await user.type(within(dialog).getByLabelText(/Extra amount/), "12.345");
    expect(within(dialog).getByText("Enter an amount like 100 or 99.50.")).toBeInTheDocument();
  });
});

describe("RefundSettingsPanel", () => {
  const SETTINGS = {
    allowedMethods: ["original", "store-credit"], approvalThreshold: 10000, returnsSkipApproval: true,
    returnsMethod: "original", codMethod: "store-credit", includeShippingOnFullRefund: true, autoCreditNote: false,
    pollMinutes: 30, maxAttempts: 3, methods: ["original", "store-credit"],
  };

  it("saves the rules", async () => {
    api.get("/admin/refunds/settings", SETTINGS);
    api.put("/admin/refunds/settings", { ...SETTINGS, approvalThreshold: 5000 });
    const { user } = renderUI(<RefundSettingsPanel />);
    const threshold = await screen.findByLabelText(/Approval needed above/);
    await user.clear(threshold);
    await user.type(threshold, "5000");
    await user.click(screen.getByRole("button", { name: "Save refund rules" }));
    await waitFor(() => expect(api.last("PUT", "/admin/refunds/settings")?.body).toMatchObject({ approvalThreshold: 5000 }));
    expect(api.last("PUT", "/admin/refunds/settings")?.body.methods).toBeUndefined();
  });

  it("needs at least one refund method", async () => {
    api.get("/admin/refunds/settings", SETTINGS);
    const { user } = renderUI(<RefundSettingsPanel />);
    await user.click(await screen.findByLabelText("Original payment method"));
    await user.click(screen.getByLabelText("Store credit"));
    await user.click(screen.getByRole("button", { name: "Save refund rules" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Allow at least one way to refund.");
    expect(api.requests("PUT", "/admin/refunds/settings")).toHaveLength(0);
  });

  it("isn't shown to staff who can't change it", async () => {
    api.get("/admin/refunds/settings", fail(403, "Forbidden", "FORBIDDEN"));
    const { container } = renderUI(<RefundSettingsPanel />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe("OrderRefunds (customer)", () => {
  it("shows the customer's refunds for the order, with where the money goes", async () => {
    signIn("customer", "cus");
    api.get("/account/orders/DCZ10042/refunds", { orderNumber: "DCZ10042", items: [{
      refundNumber: "DCZ-RF-0001", orderNumber: "DCZ10042", amount: 124900, method: "original",
      methodLabel: "Original payment method",
      destinations: [{ kind: "original", amount: 124900, label: "Original payment method" }],
      reason: "Arrived damaged", status: "processing", statusLabel: "In progress",
      requestedAt: "2026-10-01T10:00:00", completedAt: null, shippingAmount: 0,
      items: [{ name: "Cotton Kurta", quantity: 1, amount: 124900 }],
    }] });
    renderUI(<OrderRefunds orderNumber="DCZ10042" />);
    expect(await screen.findByRole("heading", { name: "Refunds" })).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("₹1,249.00 to original payment method")).toBeInTheDocument();
    expect(screen.getByText(/5–7 working days/)).toBeInTheDocument();
    expect(api.last("GET", "/account/orders/DCZ10042/refunds")!.headers.authorization).toBe("Bearer cus");
  });

  it("shows nothing when there are no refunds or they can't load", async () => {
    api.get("/account/orders/DCZ10042/refunds", fail(500));
    const { container } = renderUI(<OrderRefunds orderNumber="DCZ10042" />);
    await waitFor(() => expect(api.requests("GET", "/account/orders/DCZ10042/refunds")).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AdminRefundsQueueView", () => {
  const page = (items: RefundRecord[]) => ({ items, pagination: { page: 1, page_size: 25, total: items.length, total_pages: 1 } });
  const SUMMARY = { requested: 2, awaitingApproval: 1, processing: 0, failed: 1, refundedToday: 124900, refundedTodayCount: 1 };

  it("lists refunds from the server with the summary, and opens one to approve it", async () => {
    setLocation("/admin/billing/refunds");
    api.get("/admin/refunds", page([record({ status: "requested", statusLabel: "Requested", requiresApproval: true,
      canApprove: true, canCancel: true })]));
    api.get("/admin/refunds/summary", SUMMARY);
    api.post("/admin/refunds/RF1/approve", record());
    const { user } = renderUI(<AdminRefundsQueueView />);
    expect(await screen.findByText("DCZ-RF-0001")).toBeInTheDocument();
    expect(within(screen.getByText("DCZ-RF-0001").closest("tr")!).getByText("Needs approval")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details of DCZ-RF-0001" }));
    expect(screen.getByText("1 × Cotton Kurta")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(toasts()).toContain("success:DCZ-RF-0001 approved."));
  });

  it("sends the filters from the address bar, including the approval queue", async () => {
    setLocation("/admin/billing/refunds?awaiting=1&method=store-credit&q=asha");
    api.get("/admin/refunds", page([]));
    api.get("/admin/refunds/summary", SUMMARY);
    renderUI(<AdminRefundsQueueView />);
    expect(await screen.findByText("No refunds match")).toBeInTheDocument();
    const query = api.last("GET", "/admin/refunds")!.query;
    expect(query.get("awaitingApproval")).toBe("true");
    expect(query.get("method")).toBe("store-credit");
    expect(query.get("q")).toBe("asha");
  });
});
