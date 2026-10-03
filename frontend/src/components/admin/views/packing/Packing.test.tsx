import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { setLocation } from "@/test/navigation";
import {
  labelOverview,
  labelVersion,
  packageView,
  packingActions,
  packingJob,
  packingLine,
  packingQueue,
  queueRow,
} from "@/test/packing-fixtures";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { useToastStore } from "@/store/toastStore";

import { AdminPackingJobView } from "./AdminPackingJobView";
import { AdminPackingQueueView } from "./AdminPackingQueueView";
import { BulkLabelBar } from "./BulkLabelBar";
import { FulfilmentSettingsPanel } from "./FulfilmentSettingsPanel";
import { OrderPackingPanel } from "./OrderPackingPanel";
import { ShipmentLabelPanel } from "./ShipmentLabelPanel";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

const SUMMARY = {
  waitingToPick: 4, waitingToPack: 2, packedToday: 9, overdue: 1, slaHours: 24,
  labelsPending: 3, labelsGeneratedToday: 5, labelFailures: 0,
};

function serveQueue(queue = packingQueue()) {
  api.get("/admin/packing", queue);
  api.get("/admin/packing/summary", SUMMARY);
  api.get("/admin/packing/staff", [{ id: "A1", name: "Ravi", role: "staff" }]);
}

async function openJob(job = packingJob()) {
  setLocation(`/admin/packing/job?id=${job.id}`);
  api.get("/admin/packing/staff", [{ id: "A1", name: "Ravi", role: "staff" }]);
  api.get(`/admin/packing/${job.id}`, job);
  const view = renderUI(<AdminPackingJobView />);
  await screen.findByRole("heading", { name: `Pack order #${job.order!.orderNumber}` });
  return view;
}

describe("AdminPackingQueueView", () => {
  it("lists the queue with the admin token, linking each order to its packing workspace", async () => {
    signIn("admin", "adm");
    setLocation("/admin/packing");
    serveQueue(packingQueue([
      queueRow(),
      queueRow({ id: 8, orderNumber: "DCZ10043", priority: "urgent", paymentStatus: "cod-pending",
        assignedTo: { id: "A1", name: "Ravi" }, aging: { hours: 30, slaHours: 24, overdue: true } }),
    ]));
    renderUI(<AdminPackingQueueView />);

    const link = await screen.findByRole("link", { name: "#DCZ10042" });
    expect(link).toHaveAttribute("href", "/admin/packing/job?id=7");
    expect(api.last("GET", "/admin/packing")!.headers.authorization).toBe("Bearer adm");
    const urgent = screen.getByRole("link", { name: "#DCZ10043" }).closest("tr")!;
    expect(within(urgent).getByText("Urgent")).toBeInTheDocument();
    expect(within(urgent).getByText("COD")).toBeInTheDocument();
    expect(within(urgent).getByText("Ravi")).toBeInTheDocument();
    expect(within(urgent).getByText("Overdue:")).toBeInTheDocument();
    expect(await screen.findByText("9")).toBeInTheDocument();
  });

  it("sends the filters from the address bar", async () => {
    setLocation("/admin/packing?status=packing&assignedTo=me&priority=urgent&overdue=1&scope=all");
    serveQueue();
    renderUI(<AdminPackingQueueView />);
    await screen.findByRole("link", { name: "#DCZ10042" });
    const query = api.last("GET", "/admin/packing")!.query;
    expect(query.get("status")).toBe("packing");
    expect(query.get("assignedTo")).toBe("me");
    expect(query.get("priority")).toBe("urgent");
    expect(query.get("overdue")).toBe("true");
    expect(query.get("scope")).toBe("all");
  });

  it("says so when nothing is waiting", async () => {
    setLocation("/admin/packing");
    serveQueue(packingQueue([]));
    renderUI(<AdminPackingQueueView />);
    expect(await screen.findByText("Nothing to pack")).toBeInTheDocument();
  });
});

describe("AdminPackingJobView", () => {
  it("offers only the actions the server allows", async () => {
    await openJob(packingJob({ actions: packingActions({ slip: true }) }));
    expect(screen.queryByRole("button", { name: "Start picking" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pick everything" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add package" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Preview/ })).toBeEnabled();
  });

  it("starts picking and shows the job the server returns", async () => {
    const { user } = await openJob();
    api.post("/admin/packing/7/start-picking", packingJob({
      status: "picking", statusLabel: "Picking", actions: packingActions({ pick: true, completePicking: true }),
    }));
    await user.click(screen.getByRole("button", { name: "Start picking" }));
    expect(await screen.findByRole("button", { name: "Picking complete" })).toBeInTheDocument();
    expect(toasts()).toContain("success:Picking started.");
  });

  it("saves a picked quantity for one line", async () => {
    const { user } = await openJob(packingJob({ status: "picking", actions: packingActions({ pick: true }) }));
    api.post("/admin/packing/7/lines/31/pick", packingJob({
      status: "picking", lines: [packingLine({ pickedQty: 1, remainingQty: 1 })], actions: packingActions({ pick: true }),
    }));
    const input = screen.getByLabelText("Picked quantity of Cotton Kurta");
    await user.clear(input);
    await user.type(input, "1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.last("POST", "/admin/packing/7/lines/31/pick")?.body).toEqual({ quantity: 1 }));
  });

  it("refuses a picked quantity above what was ordered", async () => {
    const { user } = await openJob(packingJob({ status: "picking", actions: packingActions({ pick: true }) }));
    const input = screen.getByLabelText("Picked quantity of Cotton Kurta");
    await user.clear(input);
    await user.type(input, "5");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("records a problem with a line, with its type, quantity and note", async () => {
    const { user } = await openJob(packingJob({ status: "picking", actions: packingActions({ pick: true }) }));
    api.post("/admin/packing/7/lines/31/exception", packingJob({
      status: "picking", actions: packingActions({ pick: true }),
      lines: [packingLine({ exception: { type: "damaged", label: "Damaged", quantity: 1, note: "Torn seam", by: "Ravi", at: "" } })],
    }));
    await user.click(screen.getByRole("button", { name: "Problem…" }));
    const dialog = await screen.findByRole("dialog", { name: "Problem with Cotton Kurta" });
    await user.selectOptions(within(dialog).getByLabelText("What's wrong"), "damaged");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Note/), "Torn seam");
    await user.click(confirm);
    await waitFor(() => expect(api.last("POST", "/admin/packing/7/lines/31/exception")?.body)
      .toEqual({ type: "damaged", quantity: 1, note: "Torn seam" }));
    expect(await screen.findByText("Damaged × 1: Torn seam")).toBeInTheDocument();
  });

  it("asks for a reason when picking finishes with problems recorded, then sends it", async () => {
    const { user } = await openJob(packingJob({ status: "picking", actions: packingActions({ pick: true, completePicking: true }) }));
    api.post("/admin/packing/7/complete-picking", (req) => req.body?.overrideReason
      ? packingJob({ status: "picked", statusLabel: "Picked", actions: packingActions({ startPacking: true }) })
      : fail(409, "Some lines have problems.", "PICK_EXCEPTIONS"));
    await user.click(screen.getByRole("button", { name: "Picking complete" }));
    const dialog = await screen.findByRole("dialog", { name: "Finish picking with problems recorded?" });
    await user.type(within(dialog).getByLabelText(/Reason/), "Customer agreed to a partial shipment");
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("button", { name: "Start packing" })).toBeInTheDocument();
    expect(api.last("POST", "/admin/packing/7/complete-picking")?.body)
      .toEqual({ overrideReason: "Customer agreed to a partial shipment" });
  });

  it("adds a package with its weight, size and items", async () => {
    const picked = packingLine({ pickedQty: 2, remainingQty: 0 });
    const { user } = await openJob(packingJob({ status: "packing", lines: [picked],
      actions: packingActions({ editPackages: true }) }));
    api.post("/admin/packing/7/packages", packingJob({ status: "packing", lines: [{ ...picked, allocatedQty: 2 }],
      packages: [packageView()], actions: packingActions({ editPackages: true, markPacked: true }) }));
    await user.click(screen.getByRole("button", { name: "Add package" }));
    const form = screen.getByRole("form", { name: "New package" });
    await user.type(within(form).getByLabelText(/Weight/), "850");
    await user.type(within(form).getByLabelText(/Length/), "30");
    await user.type(within(form).getByLabelText(/Width/), "20");
    await user.type(within(form).getByLabelText(/Height/), "10");
    expect(within(form).getByText("1.2 kg")).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Add package" }));
    await waitFor(() => expect(api.last("POST", "/admin/packing/7/packages")?.body).toEqual({
      type: "box", weightGrams: 850, lengthCm: 30, widthCm: 20, heightCm: 10, notes: "",
      items: [{ lineId: 31, quantity: 2 }],
    }));
    expect(await screen.findByText("PKG-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark packed" })).toBeEnabled();
  });

  it("checks a package before sending it", async () => {
    const { user } = await openJob(packingJob({ status: "packing", lines: [packingLine({ pickedQty: 2 })],
      actions: packingActions({ editPackages: true }) }));
    await user.click(screen.getByRole("button", { name: "Add package" }));
    const form = screen.getByRole("form", { name: "New package" });
    await user.click(within(form).getByRole("button", { name: "Add package" }));
    expect(within(form).getByText("Enter the weight in whole grams.")).toBeInTheDocument();
    expect(api.requests("POST", "/admin/packing/7/packages")).toHaveLength(0);
  });

  it("confirms warnings with a reason before marking packed", async () => {
    const { user } = await openJob(packingJob({
      status: "packing", packages: [packageView()], actions: packingActions({ markPacked: true }),
      validation: { ready: true, errors: [], critical: [{ code: "HEAVY", message: "Package is over 20 kg." }] },
    }));
    api.post("/admin/packing/7/packed", packingJob({ status: "packed", statusLabel: "Packed",
      actions: packingActions({ ready: true, reopen: true }) }));
    await user.click(screen.getByRole("button", { name: "Mark packed" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark packed despite warnings?" });
    expect(within(dialog).getByText("Package is over 20 kg.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Reason/), "Checked with courier");
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("button", { name: "Ready to ship" })).toBeInTheDocument();
    expect(api.last("POST", "/admin/packing/7/packed")?.body).toEqual({ confirm: true, overrideReason: "Checked with courier" });
  });

  it("shows the server's message when an action is refused", async () => {
    const { user } = await openJob();
    api.post("/admin/packing/7/start-picking", fail(409, "Someone else already started it.", "INVALID_TRANSITION"));
    await user.click(screen.getByRole("button", { name: "Start picking" }));
    await waitFor(() => expect(toasts()).toContain("error:Someone else already started it."));
  });

  it("assigns the job to a member of staff", async () => {
    const { user } = await openJob();
    api.post("/admin/packing/7/assign", packingJob({ assignedTo: { id: "A1", name: "Ravi" } }));
    await screen.findByRole("option", { name: "Ravi" });
    await user.selectOptions(screen.getByLabelText("Assigned to"), "A1");
    await waitFor(() => expect(api.last("POST", "/admin/packing/7/assign")?.body).toEqual({ adminId: "A1" }));
  });

  it("says when the job doesn't load", async () => {
    setLocation("/admin/packing/job?id=99");
    api.get("/admin/packing/staff", []);
    api.get("/admin/packing/99", fail(404, "No packing job.", "NOT_FOUND"));
    renderUI(<AdminPackingJobView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No packing job.");
  });
});

describe("ShipmentLabelPanel", () => {
  it("generates a label in the chosen size", async () => {
    api.get("/admin/shipments/12/labels", labelOverview());
    api.post("/admin/shipments/12/labels", labelOverview({ status: "generated", current: labelVersion(), history: [labelVersion()] }));
    const { user } = renderUI(<ShipmentLabelPanel shipmentId={12} />);
    await user.selectOptions(await screen.findByLabelText("Label size"), "a4");
    await user.click(screen.getByRole("button", { name: /Generate label/ }));
    expect(await screen.findByRole("button", { name: /Download/ })).toBeInTheDocument();
    expect(api.last("POST", "/admin/shipments/12/labels")?.body).toEqual({ format: "a4" });
    expect(toasts()).toContain("success:Label generated.");
  });

  it("lists what a label still needs", async () => {
    api.get("/admin/shipments/12/labels", labelOverview({ canGenerate: false,
      problems: [{ code: "NO_PACKAGE", message: "Add the package weight first." }] }));
    renderUI(<ShipmentLabelPanel shipmentId={12} />);
    expect(await screen.findByText("Add the package weight first.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Generate label/ })).not.toBeInTheDocument();
  });

  it("needs a reason to regenerate, and keeps earlier versions in the history", async () => {
    const v1 = labelVersion({ id: 60, version: 1, current: false, status: "regenerated", statusLabel: "Replaced" });
    const v2 = labelVersion({ version: 2, reason: "Wrong address" });
    api.get("/admin/shipments/12/labels", labelOverview({ status: "generated", current: labelVersion(), history: [labelVersion()] }));
    api.post("/admin/shipments/12/labels/regenerate", labelOverview({ status: "regenerated", current: v2, history: [v2, v1] }));
    const { user } = renderUI(<ShipmentLabelPanel shipmentId={12} />);
    await user.click(await screen.findByRole("button", { name: /Regenerate/ }));
    const dialog = await screen.findByRole("dialog", { name: "Make a new label?" });
    const confirm = within(dialog).getByRole("button", { name: "Regenerate" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Reason/), "Wrong address");
    await user.click(confirm);
    await waitFor(() => expect(api.last("POST", "/admin/shipments/12/labels/regenerate")?.body)
      .toEqual({ reason: "Wrong address", format: "thermal-4x6" }));
    expect(await screen.findByText("Earlier versions (1)")).toBeInTheDocument();
  });

  it("cancels a label with a reason", async () => {
    api.get("/admin/shipments/12/labels", labelOverview({ status: "generated", current: labelVersion(), history: [labelVersion()] }));
    api.post("/admin/shipments/12/labels/cancel", labelOverview({ status: "cancelled",
      current: labelVersion({ status: "cancelled", printable: false }) }));
    const { user } = renderUI(<ShipmentLabelPanel shipmentId={12} />);
    await user.click(await screen.findByRole("button", { name: /Cancel label/ }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel this label?" });
    await user.type(within(dialog).getByLabelText(/Reason/), "Order cancelled");
    await user.click(within(dialog).getByRole("button", { name: "Cancel label" }));
    await waitFor(() => expect(api.last("POST", "/admin/shipments/12/labels/cancel")?.body).toEqual({ reason: "Order cancelled" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Download/ })).not.toBeInTheDocument());
  });
});

describe("BulkLabelBar", () => {
  it("generates labels for the selected shipments and lists the ones that failed", async () => {
    api.post("/admin/shipping-labels/bulk", {
      results: [
        { shipmentId: 12, ok: true, created: true, label: labelVersion() },
        { shipmentId: 13, ok: false, error: { code: "LABEL_NOT_READY", message: "No AWB yet." } },
      ],
      succeeded: 1, failed: 1,
    });
    let done = 0;
    const { user } = renderUI(<BulkLabelBar selected={[12, 13]} labels={{ 12: "SH-12", 13: "SH-13" }}
      onClear={() => undefined} onDone={() => { done += 1; }} />);
    await user.click(screen.getByRole("button", { name: /Generate labels/ }));
    const dialog = await screen.findByRole("dialog", { name: "Some labels weren't made" });
    expect(within(dialog).getByText("SH-13")).toBeInTheDocument();
    expect(within(dialog).getByText("No AWB yet.")).toBeInTheDocument();
    expect(api.last("POST", "/admin/shipping-labels/bulk")?.body).toEqual({ shipmentIds: [12, 13] });
    expect(done).toBe(1);
  });

  it("refuses more than 100 at a time", () => {
    const many = Array.from({ length: 101 }, (_, index) => index + 1);
    renderUI(<BulkLabelBar selected={many} labels={{}} onClear={() => undefined} onDone={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Up to 100 at a time.");
    expect(screen.getByRole("button", { name: /Generate labels/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Download ZIP/ })).toBeDisabled();
  });

  it("is hidden with nothing selected", () => {
    const { container } = renderUI(<BulkLabelBar selected={[]} labels={{}} onClear={() => undefined} onDone={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("FulfilmentSettingsPanel", () => {
  const SETTINGS = {
    slaHours: 24, volumetricDivisor: 5000, slipShowPrices: false, labelFormat: "thermal-4x6", defaultPackage: null,
    formats: labelOverview().formats, packageTypes: ["box", "envelope", "polybag"],
  };

  it("saves the settings, with a default package only when one is entered", async () => {
    api.get("/admin/fulfilment/settings", SETTINGS);
    api.put("/admin/fulfilment/settings", { ...SETTINGS, slaHours: 12 });
    const { user } = renderUI(<FulfilmentSettingsPanel />);
    const sla = await screen.findByLabelText(/Pack within/);
    await user.clear(sla);
    await user.type(sla, "12");
    await user.click(screen.getByRole("button", { name: "Save packing settings" }));
    await waitFor(() => expect(api.last("PUT", "/admin/fulfilment/settings")?.body).toEqual({
      slaHours: 12, volumetricDivisor: 5000, slipShowPrices: false, labelFormat: "thermal-4x6", defaultPackage: null,
    }));
  });

  it("checks the values before saving", async () => {
    api.get("/admin/fulfilment/settings", SETTINGS);
    const { user } = renderUI(<FulfilmentSettingsPanel />);
    const divisor = await screen.findByLabelText(/Volumetric divisor/);
    await user.clear(divisor);
    await user.type(divisor, "50");
    await user.type(screen.getByLabelText("Weight (g)"), "500");
    await user.click(screen.getByRole("button", { name: "Save packing settings" }));
    expect(screen.getByText("1000 to 10000 (most couriers use 5000).")).toBeInTheDocument();
    expect(screen.getAllByText("0.1 to 300 cm.")).toHaveLength(3);
    expect(api.requests("PUT", "/admin/fulfilment/settings")).toHaveLength(0);
  });

  it("isn't shown without the settings permission", async () => {
    api.get("/admin/fulfilment/settings", fail(403, "Forbidden", "FORBIDDEN"));
    const { container } = renderUI(<FulfilmentSettingsPanel />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe("OrderPackingPanel", () => {
  it("shows where the order is in packing and links to the workspace", async () => {
    api.get("/admin/orders/ORD042/packing", { job: { id: 7, status: "packing", statusLabel: "Packing", priority: "high",
      packageCount: 2, packedAt: null, assignedTo: "Ravi" } });
    renderUI(<OrderPackingPanel orderId="ORD042" />);
    expect(await screen.findByRole("link", { name: "Open packing" })).toHaveAttribute("href", "/admin/packing/job?id=7");
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("2 packages · Ravi")).toBeInTheDocument();
  });

  it("is hidden for staff without the packing permission", async () => {
    api.get("/admin/orders/ORD042/packing", fail(403, "Forbidden", "FORBIDDEN"));
    const { container } = renderUI(<OrderPackingPanel orderId="ORD042" />);
    await waitFor(() => expect(api.requests("GET", "/admin/orders/ORD042/packing")).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });
});
