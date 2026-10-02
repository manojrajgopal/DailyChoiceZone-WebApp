import { describe, expect, it } from "vitest";

import type { ReturnRequest } from "@/types/returns";
import { api, fail, networkError } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { useToastStore } from "@/store/toastStore";

import { AdminReturnDetailView, AdminReturnsView, ReturnStatusBadge } from "./AdminReturnsView";

function returnRequest(overrides: Partial<ReturnRequest> = {}): ReturnRequest {
  return {
    id: "RET-1",
    orderId: "ORD-1",
    orderNumber: "1001",
    kind: "return",
    status: "requested",
    reason: "Too small",
    comment: "",
    resolutionNote: "",
    amount: 129900,
    refundId: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    canCancel: true,
    items: [
      { orderItemId: 1, productId: "P1", name: "Linen shirt", image: "/a.jpg", size: "M", color: "Blue", quantity: 2, amount: 99900 },
      { orderItemId: 2, productId: "P2", name: "Scarf", image: "", size: null, color: null, quantity: 1, amount: 30000 },
    ],
    timeline: [{ status: "requested", note: "", by: "customer", at: "2026-09-20T10:00:00.000Z" }],
    customerId: "C1",
    customerName: "Meera Iyer",
    nextSteps: ["approved", "rejected"],
    ...overrides,
  };
}

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

describe("ReturnStatusBadge", () => {
  it.each([
    ["requested", "Requested"],
    ["rejected", "Declined"],
    ["replacement-shipped", "Replacement shipped"],
    ["completed", "Completed"],
  ] as const)("labels %s as %s", (status, label) => {
    renderUI(<ReturnStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("falls back to the raw status and the neutral tone for an unknown status", () => {
    renderUI(<ReturnStatusBadge status={"mystery" as unknown as "requested"} />);
    const badge = screen.getByText("mystery");
    expect(badge.className).toContain("text-admin-muted");
  });
});

describe("AdminReturnsView", () => {
  describe("success cases", () => {
    it("lists requests with the admin token, totals the units and links each to its detail", async () => {
      signIn("admin", "adm");
      api.get("/admin/returns", [
        returnRequest(),
        returnRequest({ id: "RPL/2", kind: "replacement", status: "approved", customerName: "Ravi", orderNumber: "1002" }),
      ]);
      renderUI(<AdminReturnsView />);

      expect(screen.getByLabelText("Loading")).toBeInTheDocument();
      const link = await screen.findByRole("link", { name: "RET-1" });
      expect(link).toHaveAttribute("href", "/admin/returns/detail?id=RET-1");
      expect(screen.getByRole("link", { name: "RPL/2" })).toHaveAttribute("href", "/admin/returns/detail?id=RPL%2F2");

      const rows = screen.getAllByRole("row");
      expect(within(rows[1]!).getByText("Return")).toBeInTheDocument();
      expect(within(rows[1]!).getByText("#1001")).toBeInTheDocument();
      expect(within(rows[1]!).getByText("3")).toBeInTheDocument();
      expect(within(rows[1]!).getByText("Meera Iyer")).toBeInTheDocument();
      expect(within(rows[2]!).getByText("Replacement")).toBeInTheDocument();
      expect(within(rows[2]!).getByText("Approved")).toBeInTheDocument();

      const request = api.last("GET", "/admin/returns")!;
      expect(request.headers.authorization).toBe("Bearer adm");
      expect(request.query.get("status")).toBeNull();
    });

    it("filters by status from the tabs and marks the chosen tab selected", async () => {
      api.get("/admin/returns", (req) =>
        req.query.get("status") === "refunded" ? [] : [returnRequest()],
      );
      const { user } = renderUI(<AdminReturnsView />);
      await screen.findByRole("link", { name: "RET-1" });
      expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");

      await user.click(screen.getByRole("tab", { name: "Refunded" }));
      expect(screen.getByRole("tab", { name: "Refunded" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "false");
      expect(await screen.findByText("No requests with this status.")).toBeInTheDocument();
      expect(api.last("GET", "/admin/returns")!.query.get("status")).toBe("refunded");

      await user.click(screen.getByRole("tab", { name: "All" }));
      expect(await screen.findByRole("link", { name: "RET-1" })).toBeInTheDocument();
      expect(api.last("GET", "/admin/returns")!.query.get("status")).toBeNull();
    });
  });

  describe("empty and error states", () => {
    it("says there are no requests yet when the unfiltered list is empty", async () => {
      api.get("/admin/returns", []);
      renderUI(<AdminReturnsView />);
      expect(await screen.findByText("No requests yet.")).toBeInTheDocument();
    });

    it.each([
      ["a server error", fail(500)],
      ["a network failure", networkError()],
    ])("shows the empty state on %s", async (_, reply) => {
      api.get("/admin/returns", reply);
      renderUI(<AdminReturnsView />);
      expect(await screen.findByText("No requests yet.")).toBeInTheDocument();
    });
  });
});

describe("AdminReturnDetailView", () => {
  describe("loading and missing", () => {
    it("shows not-found straight away when there is no id", async () => {
      renderUI(<AdminReturnDetailView />);
      expect(await screen.findByRole("heading", { name: "Request not found" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin/dashboard");
      expect(screen.getByText("Returns")).toHaveAttribute("aria-current", "page");
      expect(api.calls).toHaveLength(0);
    });

    it("shows a spinner, then not-found when the request can't be read", async () => {
      setLocation("/admin/returns/detail?id=RET-404");
      api.get("/admin/returns/RET-404", fail(404, "Not found"));
      renderUI(<AdminReturnDetailView />);
      expect(screen.getByLabelText("Loading request")).toBeInTheDocument();
      expect(await screen.findByText("We couldn’t find this request.")).toBeInTheDocument();
    });
  });

  describe("success cases", () => {
    it("shows the items, reason, value, note, history and order link", async () => {
      setLocation("/admin/returns/detail?id=RET-1");
      api.get(
        "/admin/returns/RET-1",
        returnRequest({
          comment: "Please hurry",
          resolutionNote: "Pickup on Monday",
          timeline: [
            { status: "requested", note: "", by: "customer", at: "2026-09-20T10:00:00.000Z" },
            { status: "approved", note: "Looks fine", by: "staff", at: "2026-09-21T10:00:00.000Z" },
            { status: "picked-up", note: "", by: "system", at: "2026-09-22T10:00:00.000Z" },
          ],
        }),
      );
      renderUI(<AdminReturnDetailView />);

      expect(await screen.findByRole("heading", { name: "Return RET-1" })).toBeInTheDocument();
      expect(screen.getByText(/Order #1001 · Meera Iyer · requested/)).toBeInTheDocument();
      expect(screen.getByText("Linen shirt")).toBeInTheDocument();
      expect(screen.getByText("M · Blue · Qty 2")).toBeInTheDocument();
      expect(screen.getByText("· Qty 1")).toBeInTheDocument();
      expect(screen.getByText("Too small")).toBeInTheDocument();
      expect(screen.getByText("Refund value")).toBeInTheDocument();
      expect(screen.getByText("₹1,299")).toBeInTheDocument();
      expect(screen.getByText("Please hurry")).toBeInTheDocument();
      expect(screen.getByText("Looks fine")).toBeInTheDocument();
      expect(screen.getByText(/· Customer$/)).toBeInTheDocument();
      expect(screen.getByText(/· Staff$/)).toBeInTheDocument();
      expect(screen.getByText(/· Automatic$/)).toBeInTheDocument();
      expect(screen.getByText("Last note to the customer: Pickup on Monday")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open order #1001" })).toHaveAttribute("href", "/admin/orders/detail?id=ORD-1");
    });

    it("labels a replacement's value and says when nothing more is needed", async () => {
      setLocation("/admin/returns/detail?id=RPL-1");
      api.get("/admin/returns/RPL-1", returnRequest({ id: "RPL-1", kind: "replacement", status: "completed", nextSteps: [] }));
      renderUI(<AdminReturnDetailView />);
      expect(await screen.findByRole("heading", { name: "Replacement RPL-1" })).toBeInTheDocument();
      expect(screen.getByText("Value of items")).toBeInTheDocument();
      expect(screen.getByText(/This request is completed and needs no/)).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("treats missing next steps as none", async () => {
      setLocation("/admin/returns/detail?id=RET-1");
      api.get("/admin/returns/RET-1", returnRequest({ nextSteps: undefined, status: "cancelled" }));
      renderUI(<AdminReturnDetailView />);
      expect(await screen.findByText(/This request is cancelled/)).toBeInTheDocument();
    });

    it("approves without confirmation, sending the note, and shows the updated request", async () => {
      signIn("admin", "adm");
      setLocation("/admin/returns/detail?id=RET-1");
      api.get("/admin/returns/RET-1", returnRequest());
      api.put("/admin/returns/RET-1/status", returnRequest({ status: "approved", nextSteps: ["picked-up"] }));
      const { user } = renderUI(<AdminReturnDetailView />);

      await user.type(await screen.findByRole("textbox", { name: "Note to the customer" }), "Pickup Monday");
      await user.click(screen.getByRole("button", { name: "Approve" }));

      expect(await screen.findByRole("button", { name: "Mark picked up" })).toBeInTheDocument();
      const request = api.last("PUT", "/admin/returns/RET-1/status")!;
      expect(request.body).toEqual({ status: "approved", note: "Pickup Monday" });
      expect(request.headers.authorization).toBe("Bearer adm");
      expect(toasts()).toContain("success:Request approved");
      expect(screen.getByRole("textbox", { name: "Note to the customer" })).toHaveValue("");
    });

    it("asks before declining; cancelling the dialog sends nothing", async () => {
      setLocation("/admin/returns/detail?id=RET-1");
      api.get("/admin/returns/RET-1", returnRequest());
      const { user } = renderUI(<AdminReturnDetailView />);

      await user.click(await screen.findByRole("button", { name: "Decline" }));
      const dialog = screen.getByRole("dialog", { name: "Decline?" });
      expect(dialog).toHaveTextContent("Decline this request? The customer will see your note.");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.requests("PUT")).toHaveLength(0);
    });

    it("declines once confirmed", async () => {
      setLocation("/admin/returns/detail?id=RET-1");
      api.get("/admin/returns/RET-1", returnRequest());
      api.put("/admin/returns/RET-1/status", returnRequest({ status: "rejected", nextSteps: [] }));
      const { user } = renderUI(<AdminReturnDetailView />);

      await user.click(await screen.findByRole("button", { name: "Decline" }));
      await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Decline" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.last("PUT")!.body).toEqual({ status: "rejected", note: "" });
      expect(toasts()).toContain("success:Request declined");
      expect(screen.getByText(/This request is declined/)).toBeInTheDocument();
    });

    it.each([
      ["refunded", "Issue refund", /Refund the customer now\?/],
      ["replacement-shipped", "Ship replacement", /The units are taken from stock/],
      ["cancelled", "Cancel request", /available to request again/],
    ] as const)("confirms %s with its own copy", async (step, label, copy) => {
      setLocation("/admin/returns/detail?id=RET-1");
      api.get("/admin/returns/RET-1", returnRequest({ nextSteps: [step] }));
      const { user } = renderUI(<AdminReturnDetailView />);
      await user.click(await screen.findByRole("button", { name: label }));
      expect(screen.getByRole("dialog", { name: `${label}?` })).toHaveTextContent(copy);
    });

    it("uses the status label for a step with no copy of its own", async () => {
      setLocation("/admin/returns/detail?id=RET-1");
      api.get("/admin/returns/RET-1", returnRequest({ nextSteps: ["requested", "received", "completed"] }));
      renderUI(<AdminReturnDetailView />);
      expect(await screen.findByRole("button", { name: "Requested" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mark received" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mark completed" })).toBeInTheDocument();
    });
  });

  describe("error cases", () => {
    it("shows the server's reason and keeps the request and note as they were", async () => {
      setLocation("/admin/returns/detail?id=RET-1");
      api.get("/admin/returns/RET-1", returnRequest());
      api.put("/admin/returns/RET-1/status", fail(409, "Already approved"));
      const { user } = renderUI(<AdminReturnDetailView />);

      await user.type(await screen.findByRole("textbox"), "x");
      await user.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(toasts()).toContain("error:Already approved"));
      expect(screen.getByRole("textbox")).toHaveValue("x");
      expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    });

    it("shows a generic reason when the network fails", async () => {
      setLocation("/admin/returns/detail?id=RET-1");
      api.get("/admin/returns/RET-1", returnRequest());
      api.put("/admin/returns/RET-1/status", networkError());
      const { user } = renderUI(<AdminReturnDetailView />);
      await user.click(await screen.findByRole("button", { name: "Approve" }));
      await waitFor(() => expect(toasts().some((t) => t.startsWith("error:"))).toBe(true));
    });
  });
});
