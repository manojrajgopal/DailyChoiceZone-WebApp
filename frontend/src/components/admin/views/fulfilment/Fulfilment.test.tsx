import { describe, expect, it, vi } from "vitest";

import { api, fail } from "@/test/api";
import { router } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import type { FulfilmentAction, OrderFulfilment } from "@/types/fulfilment";

import { FulfilmentHistory } from "./FulfilmentHistory";
import { FulfilmentProgress } from "./FulfilmentProgress";
import { OrderFulfilmentPanel } from "./OrderFulfilmentPanel";

/* -------------------------------------------------------------- fixtures */

const STEP_KEYS = [
  ["placed", "Order placed", "order"],
  ["confirmed", "Confirmed", "order"],
  ["picking", "Picking", "packing"],
  ["packing", "Packing", "packing"],
  ["packed", "Packed", "packing"],
  ["shipment-created", "Shipment created", "shipment"],
  ["ready-for-pickup", "Ready for pickup", "shipment"],
  ["delivered", "Delivered", "shipment"],
] as const;

function steps(current: string, overrides: Record<string, OrderFulfilment["progress"]["steps"][number]["state"]> = {}) {
  const at = STEP_KEYS.findIndex(([key]) => key === current);
  return STEP_KEYS.map(([key, label, phase], index) => ({
    key, label, phase, optional: false,
    state: overrides[key] ?? (index < at ? "completed" : index === at ? "current" : "upcoming"),
  })) as OrderFulfilment["progress"]["steps"];
}

function action(overrides: Partial<FulfilmentAction>): FulfilmentAction {
  return {
    key: "start-packing", label: "Move to packing", kind: "order", allowed: true, blockedReason: "", primary: true,
    requiresReason: false, destructive: false, description: "Start picking this order's items in the warehouse.",
    target: "processing", ...overrides,
  };
}

function fulfilment(overrides: Partial<OrderFulfilment> = {}): OrderFulfilment {
  return {
    order: { id: "ORD042", orderNumber: "DCZ10042", status: "confirmed", statusLabel: "Confirmed",
      paymentStatus: "paid", paymentMethod: "upi", stockState: "consumed" },
    payment: { status: "paid", method: "upi", blocked: null },
    progress: { currentStep: "confirmed", exception: "", terminal: "", legacy: false, steps: steps("confirmed") },
    nextActions: [
      action({}),
      action({ key: "cancel", label: "Cancel order", primary: false, destructive: true, target: "cancelled",
        description: "Stock goes back." }),
    ],
    packing: { id: 7, status: "pending", statusLabel: "Waiting to pick", priority: "normal", assignedTo: "",
      pickingStartedAt: null, pickedAt: null, packingStartedAt: null, packedAt: null, packedBy: "", notes: "",
      packageCount: 0, packages: [], href: "/admin/packing/job?id=7" },
    shipment: null,
    shipments: [],
    returns: [],
    warnings: [],
    history: [],
    ...overrides,
  };
}

function panel(data: OrderFulfilment | null, onChanged = vi.fn()) {
  const view = renderUI(
    <OrderFulfilmentPanel orderId="ORD042" data={data} loading={false} failed={false} onRetry={vi.fn()} onChanged={onChanged} />,
  );
  return { ...view, onChanged };
}

/* ------------------------------------------------------------- progress */

describe("FulfilmentProgress", () => {
  it("marks each step with the state the server gave it, never inferring a future step as done", () => {
    renderUI(<FulfilmentProgress progress={{ currentStep: "packed", exception: "", terminal: "", legacy: false,
      steps: steps("packed") }} />);
    const state = (label: string) => screen.getByText(label, { selector: "span" }).closest("li")?.dataset.state;
    expect(state("Packed")).toBe("current");
    expect(state("Confirmed")).toBe("completed");
    expect(state("Shipment created")).toBe("upcoming");
    expect(state("Delivered")).toBe("upcoming");
    expect(screen.getByText("Packed").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("shows exceptions and skipped steps as such", () => {
    const progress = {
      currentStep: "ready-for-pickup", exception: "delivery-attempted", terminal: "", legacy: false,
      steps: [
        ...steps("ready-for-pickup", { "ready-for-pickup": "completed", picking: "skipped" }).slice(0, 7),
        { key: "delivery-attempted", label: "Delivery attempted", phase: "shipment" as const, optional: false, state: "exception" as const },
      ],
    };
    renderUI(<FulfilmentProgress progress={progress} />);
    expect(screen.getByText("Delivery attempted").closest("li")).toHaveAttribute("data-state", "exception");
    expect(screen.getByText("Picking").closest("li")).toHaveAttribute("data-state", "skipped");
  });
});

/* ---------------------------------------------------------------- panel */

describe("OrderFulfilmentPanel", () => {
  it("has no status dropdown: only the next valid step and the other allowed actions", () => {
    panel(fulfilment());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Move to")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Move to packing/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delivered|Shipped/ })).not.toBeInTheDocument();
  });

  it("confirms, sends the step, and reloads everything from the server", async () => {
    signIn("admin", "adm");
    api.post("/admin/orders/ORD042/fulfilment/actions", fulfilment({ order: { ...fulfilment().order, status: "processing" } }));
    const { user, onChanged } = panel(fulfilment());
    await user.click(screen.getByRole("button", { name: /Move to packing/ }));
    const dialog = screen.getByRole("dialog", { name: "Move to packing?" });
    expect(api.requests("POST", "/admin/orders/ORD042/fulfilment/actions")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Move to packing" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.last("POST", "/admin/orders/ORD042/fulfilment/actions")!.body).toEqual({ action: "start-packing", reason: "" });
    expect(api.last("POST", "/admin/orders/ORD042/fulfilment/actions")!.headers.authorization).toBe("Bearer adm");
  });

  it("asks for a reason before a backward move and sends it", async () => {
    api.post("/admin/orders/ORD042/fulfilment/actions", fulfilment());
    const data = fulfilment({
      order: { ...fulfilment().order, status: "packed", statusLabel: "Packed" },
      nextActions: [
        action({ key: "create-shipment", label: "Create shipment", kind: "create-shipment" }),
        action({ key: "repack", label: "Move back to packing", primary: false, requiresReason: true, destructive: true,
          description: "Reopen packing. Needs a reason." }),
      ],
    });
    const { user } = panel(data);
    await user.click(screen.getByRole("button", { name: /Move back to packing/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Move back to packing" }));
    expect(within(dialog).getByText("Give a short reason (at least 3 characters).")).toBeInTheDocument();
    expect(api.requests("POST", "/admin/orders/ORD042/fulfilment/actions")).toHaveLength(0);
    await user.type(within(dialog).getByLabelText(/^Reason/), "Package damaged and needs repacking");
    await user.click(within(dialog).getByRole("button", { name: "Move back to packing" }));
    await waitFor(() => expect(api.last("POST", "/admin/orders/ORD042/fulfilment/actions")!.body).toEqual({
      action: "repack", reason: "Package damaged and needs repacking",
    }));
  });

  it("shows the server's business error and keeps the dialog open", async () => {
    api.post("/admin/orders/ORD042/fulfilment/actions",
      fail(409, "Order cannot be packed because payment is pending.", "PAYMENT_REQUIRED"));
    const { user, onChanged } = panel(fulfilment());
    await user.click(screen.getByRole("button", { name: /Move to packing/ }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Move to packing" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Order cannot be packed because payment is pending.");
    // The page is read again even after a refusal: someone else may have moved it.
    expect(onChanged).toHaveBeenCalled();
  });

  it("shows a blocked step disabled, with why", () => {
    panel(fulfilment({
      nextActions: [action({ allowed: false, blockedReason: "Order cannot be packed because payment is failed." })],
    }));
    expect(screen.getByRole("button", { name: /Move to packing/ })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("payment is failed");
  });

  it("moves a shipment step through the shipment endpoint", async () => {
    api.post("/admin/shipments/12/status", { id: 12, status: "picked-up" });
    const data = fulfilment({
      order: { ...fulfilment().order, status: "packed", statusLabel: "Packed" },
      nextActions: [action({ key: "shipment:picked-up", label: "Mark picked up", kind: "shipment", target: "picked-up", shipmentId: 12 })],
    });
    const { user } = panel(data);
    await user.click(screen.getByRole("button", { name: /Mark picked up/ }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark picked up" }));
    await waitFor(() => expect(api.last("POST", "/admin/shipments/12/status")!.body).toEqual({ status: "picked-up", reason: "" }));
  });

  it("opens the packing workspace for a step done there", async () => {
    const data = fulfilment({
      nextActions: [action({ key: "open-packing", label: "Continue picking", kind: "link", href: "/admin/packing/job?id=7" })],
    });
    const { user } = panel(data);
    await user.click(screen.getByRole("button", { name: /Continue picking/ }));
    expect(router.push).toHaveBeenCalledWith("/admin/packing/job?id=7");
  });

  it("shows related records and legacy warnings", () => {
    panel(fulfilment({
      order: { ...fulfilment().order, status: "shipped", statusLabel: "Shipped" },
      nextActions: [],
      warnings: [{ code: "NO_SHIPMENT_RECORD", message: "This order is marked shipped, but no shipment was ever recorded for it." }],
      shipment: null,
    }));
    expect(screen.getByText(/no shipment was ever recorded/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Job #7" })).toHaveAttribute("href", "/admin/packing/job?id=7");
  });

  it("offers a retry when the details didn't load", () => {
    renderUI(<OrderFulfilmentPanel orderId="ORD042" data={null} loading={false} failed onRetry={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText("The fulfilment details didn’t load.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------- history */

describe("FulfilmentHistory", () => {
  const entries = [
    { at: "2026-09-29T04:42:00", kind: "order" as const, status: "confirmed", statusLabel: "Confirmed", fromStatus: "pending",
      title: "Order confirmed", note: "", reason: "", source: "admin", actor: "ADM001", actorName: "Admin User", entity: null },
    { at: "2026-09-29T06:00:00", kind: "packing" as const, status: "packing", statusLabel: "Packing", fromStatus: "packed",
      title: "Packing reopened to packing", note: "", reason: "Package damaged", source: "packing", actor: "ADM002",
      actorName: "Warehouse Admin", entity: { type: "packing", id: "7" } },
    { at: "2026-09-29T09:50:00", kind: "shipment" as const, status: "picked-up", statusLabel: "Picked up", fromStatus: "",
      title: "Shipment picked up", note: "Collected", reason: "", location: "Bengaluru Hub", source: "courier",
      actor: "courier", actorName: "Courier", entity: { type: "shipment", id: "DCZ-SH-2026-000012", shipmentId: 12 } },
  ];

  it("lists every change newest first, with who, when, why and the record it came from", () => {
    renderUI(<FulfilmentHistory entries={entries} />);
    const titles = screen.getAllByText(/^(Order confirmed|Packing reopened to packing|Shipment picked up)/).map((node) => node.textContent);
    expect(titles[0]).toMatch(/^Shipment picked up/);
    expect(titles[2]).toMatch(/^Order confirmed/);
    expect(screen.getByText("Reason: Package damaged")).toBeInTheDocument();
    expect(screen.getByText(/29 Sept 2026, 10:12 am · by Admin User/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "DCZ-SH-2026-000012" })).toHaveAttribute("href", "/admin/shipments/detail?id=12");
  });

  it("filters by record", async () => {
    const { user } = renderUI(<FulfilmentHistory entries={entries} />);
    await user.click(screen.getByRole("button", { name: "Packing" }));
    expect(screen.queryByText(/^Order confirmed/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Packing reopened/)).toBeInTheDocument();
  });
});
