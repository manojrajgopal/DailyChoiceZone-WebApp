import { describe, expect, it } from "vitest";

import type { Shipment } from "@/types/shipping";
import { api, fail, networkError } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { shipment, shipmentEvent } from "@/test/shipping-fixtures";
import { useToastStore } from "@/store/toastStore";

import { AdminShipmentDetailView } from "./AdminShipmentDetailView";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

const NONE: Shipment["actions"] = { label: false, pickup: false, cancel: false, refresh: false, retry: false, manualEvent: false, editPackage: false };

async function open(data: Shipment = shipment()) {
  setLocation(`/admin/shipments/detail?id=${data.id}`);
  api.get(`/admin/shipments/${data.id}`, data);
  // The store's own label panel (covered in packing/ShipmentLabelPanel.test.tsx).
  api.get(`/admin/shipments/${data.id}/labels`, {
    shipmentId: data.id, status: "not-generated", current: null, history: [], problems: [], canGenerate: false,
    courierLabelUrl: "", formats: [], defaultFormat: "4x6",
  });
  const view = renderUI(<AdminShipmentDetailView />);
  await screen.findByRole("heading", { name: `Shipment ${data.shipmentNumber}` });
  return view;
}

const actionsGroup = () => screen.getByRole("group", { name: "Shipment actions" });

describe("AdminShipmentDetailView", () => {
  describe("loading and missing", () => {
    it("is not found straight away without an id, and asks nothing", async () => {
      renderUI(<AdminShipmentDetailView />);
      expect(screen.getByRole("heading", { name: "Shipment not found" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to shipments" })).toHaveAttribute("href", "/admin/shipments");
      expect(api.calls).toHaveLength(0);
    });

    it("shows a spinner, then not-found on a 404", async () => {
      setLocation("/admin/shipments/detail?id=999");
      api.get("/admin/shipments/999", fail(404, "Not found", "NOT_FOUND"));
      renderUI(<AdminShipmentDetailView />);
      expect(screen.getByLabelText("Loading shipment")).toBeInTheDocument();
      expect(await screen.findByText("We couldn’t find this shipment.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    });

    it("shows the API's message on another error, and Try again loads it", async () => {
      setLocation("/admin/shipments/detail?id=12");
      api.get("/admin/shipments/12", shipment());
      api.once("GET", "/admin/shipments/12", fail(500, "The database is busy.", "INTERNAL"));
      const { user } = renderUI(<AdminShipmentDetailView />);

      expect(await screen.findByRole("heading", { name: "Shipment didn't load" })).toBeInTheDocument();
      expect(screen.getByText("The database is busy.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("heading", { name: "Shipment DCZ-SH-2026-000012" })).toBeInTheDocument();
    });

    it("uses a plain message when there was no answer at all", async () => {
      setLocation("/admin/shipments/detail?id=12");
      api.get("/admin/shipments/12", networkError());
      renderUI(<AdminShipmentDetailView />);
      expect(await screen.findByRole("heading", { name: "Shipment didn't load" })).toBeInTheDocument();
      // The client's own offline message is an ApiError, so it's shown as is.
      expect(screen.getByText(/couldn't connect just now/)).toBeInTheDocument();
    });
  });

  describe("what it shows", () => {
    it("shows the order, shipping details, tracking and technical panel from the API", async () => {
      signIn("admin", "adm");
      await open();

      expect(api.last("GET", "/admin/shipments/12")!.headers.authorization).toBe("Bearer adm");
      expect(screen.getByText("Order #DCZ10042 · Asha Rao · created 2 Oct 2026")).toBeInTheDocument();
      expect(screen.getAllByText("Ready for pickup").length).toBeGreaterThan(0);
      expect(screen.getByRole("link", { name: "Open order #DCZ10042" })).toHaveAttribute("href", "/admin/orders/detail?id=ORD042");
      expect(screen.getByText("Cotton Kurta")).toBeInTheDocument();
      expect(screen.getByText("DCZ-WO0001 · M · Red · Qty 2")).toBeInTheDocument();

      expect(screen.getByText("800 g · 30 × 20 × 5 cm · 1 package · box")).toBeInTheDocument();
      expect(screen.getByText("Shiprocket")).toBeInTheDocument();
      expect(screen.getByText("Delhivery Surface")).toBeInTheDocument();
      expect(screen.getAllByText("1234567890").length).toBeGreaterThan(0);
      expect(screen.getByText("Not scheduled")).toBeInTheDocument();
      expect(screen.getByText("4 Lake View")).toBeInTheDocument();
      expect(screen.getByText("Mysuru, Karnataka 570001")).toBeInTheDocument();

      const tracking = screen.getByRole("list", { name: "Tracking events" });
      expect(within(tracking).getByText("Picked up")).toBeInTheDocument();

      const panel = screen.getByLabelText("Technical details");
      expect(within(panel).getByText("Confirmed by the courier")).toBeInTheDocument();
      expect(within(panel).getByText("55555")).toBeInTheDocument();
      expect(within(panel).getByText("98765")).toBeInTheDocument();
      expect(within(panel).getByText("Never")).toBeInTheDocument(); // no webhook yet

      const download = screen.getByRole("link", { name: "Courier label" });
      expect(download).toHaveAttribute("href", "https://labels.example/12.pdf");
      expect(download).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("says the AWB isn't assigned yet and leaves the label link out when there's none", async () => {
      await open(shipment({ awb: "", label: { available: false, url: "" }, cod: true, codAmount: 2498, pickup: { status: "scheduled", scheduledAt: "2026-10-04T05:30:00", token: "PK-7" } }));
      expect(screen.getByText("Not assigned yet")).toBeInTheDocument();
      // The courier's label (the store's own label panel has its own status badge).
      expect(screen.getByText("Courier label", { selector: "dt" }).nextElementSibling).toHaveTextContent("Not generated");
      expect(screen.getByText("Collect ₹2,498")).toBeInTheDocument();
      expect(screen.getByText(/^Scheduled for .* · token PK-7$/)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Courier label" })).not.toBeInTheDocument();
      expect(within(actionsGroup()).getByRole("button", { name: "Get courier label" })).toBeInTheDocument();
    });

    it("warns about a failed courier request with the error and the next automatic retry", async () => {
      await open(
        shipment({
          technical: { ...shipment().technical, requestStatus: "failed", lastOperation: "label", lastError: "Courier timeout", lastErrorAt: "2026-10-03T07:00:00", retryCount: 2, nextRetryAt: "2026-10-03T07:10:00" },
        }),
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("The courier didn’t accept the last request (label).");
      expect(alert).toHaveTextContent("Courier timeout");
      expect(alert).toHaveTextContent(/Retrying automatically/);
      const panel = screen.getByLabelText("Technical details");
      expect(within(panel).getByText("Courier request failed")).toBeInTheDocument();
      expect(within(panel).getByText("2")).toBeInTheDocument();
    });
  });

  describe("actions are the server's decision", () => {
    it("offers exactly what `actions` allows", async () => {
      await open();
      const group = actionsGroup();
      expect(within(group).getByRole("button", { name: "Refresh tracking" })).toBeInTheDocument();
      expect(within(group).getByRole("button", { name: "Ask courier for a new label" })).toBeInTheDocument();
      expect(within(group).getByRole("button", { name: "Schedule pickup" })).toBeInTheDocument();
      expect(within(group).getByRole("button", { name: "Record event" })).toBeInTheDocument();
      expect(within(group).getByRole("button", { name: "Cancel shipment" })).toBeInTheDocument();
      expect(within(group).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
      expect(within(group).queryByRole("button", { name: "Edit package" })).not.toBeInTheDocument();
    });

    it("offers no buttons when nothing is allowed", async () => {
      await open(shipment({ actions: NONE }));
      expect(within(actionsGroup()).queryAllByRole("button")).toHaveLength(0);
    });

    it.each([
      ["refresh", "Refresh tracking"],
      ["retry", "Retry"],
      ["label", "Ask courier for a new label"],
      ["pickup", "Schedule pickup"],
      ["manualEvent", "Record event"],
      ["editPackage", "Edit package"],
      ["cancel", "Cancel shipment"],
    ] as const)("shows only %s when only it is allowed", async (key, label) => {
      await open(shipment({ actions: { ...NONE, [key]: true } }));
      const buttons = within(actionsGroup()).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual([label]);
    });
  });

  describe("running an action", () => {
    it("refreshes tracking and shows what the server answered", async () => {
      const { user } = await open();
      api.post("/admin/shipments/12/refresh", shipment({ status: "in-transit", statusLabel: "In transit", events: [shipmentEvent(), shipmentEvent({ id: 2, label: "Left the hub", occurredAt: "2026-10-04T06:00:00" })] }));
      await user.click(screen.getByRole("button", { name: "Refresh tracking" }));
      expect(await screen.findByText("Left the hub")).toBeInTheDocument();
      expect(toasts()).toContain("success:Tracking updated.");
      expect(api.requests("POST", "/admin/shipments/12/refresh")).toHaveLength(1);
    });

    it("disables every action while one is running", async () => {
      const { user } = await open();
      api.post("/admin/shipments/12/pickup", () => new Promise(() => undefined));
      await user.click(screen.getByRole("button", { name: "Schedule pickup" }));
      for (const button of within(actionsGroup()).getAllByRole("button")) expect(button).toBeDisabled();
    });

    it("retries a failed request, and says so when the courier still refuses", async () => {
      const failed = shipment({ actions: { ...NONE, retry: true }, technical: { ...shipment().technical, requestStatus: "failed", lastError: "Bad pincode" } });
      const { user } = await open(failed);
      api.post("/admin/shipments/12/retry", failed);
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(toasts()).toContain("error:The courier still didn't accept it: Bad pincode"));

      api.post("/admin/shipments/12/retry", shipment({ actions: NONE }));
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(toasts()).toContain("success:Sent to the courier again."));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    });

    it("generates a label and offers the download", async () => {
      const { user } = await open(shipment({ label: { available: false, url: "" } }));
      api.post("/admin/shipments/12/label", shipment({ label: { available: true, url: "https://labels.example/new.pdf" } }));
      await user.click(screen.getByRole("button", { name: "Get courier label" }));
      expect(await screen.findByRole("link", { name: "Courier label" })).toHaveAttribute("href", "https://labels.example/new.pdf");
      expect(toasts()).toContain("success:Label ready to download.");
    });

    it("says the label was only requested when there's no file yet", async () => {
      const { user } = await open(shipment({ label: { available: false, url: "" } }));
      api.post("/admin/shipments/12/label", shipment({ label: { available: false, url: "" } }));
      await user.click(screen.getByRole("button", { name: "Get courier label" }));
      await waitFor(() => expect(toasts()).toContain("success:Label requested."));
    });

    it.each([
      ["scheduled", "success:Pickup scheduled."],
      // A pickup the courier refused is a failure, not a success.
      ["failed", "error:The courier couldn't schedule a pickup."],
    ] as const)("reports a pickup that came back %s", async (status, toast) => {
      const { user } = await open();
      api.post("/admin/shipments/12/pickup", shipment({ pickup: { status, scheduledAt: null, token: "" } }));
      await user.click(screen.getByRole("button", { name: "Schedule pickup" }));
      await waitFor(() => expect(toasts()).toContain(toast));
    });

    it("shows the API's message when an action fails and lets you try again", async () => {
      const { user } = await open();
      api.post("/admin/shipments/12/refresh", fail(502, "Shiprocket didn't answer.", "COURIER_UNAVAILABLE"));
      await user.click(screen.getByRole("button", { name: "Refresh tracking" }));
      await waitFor(() => expect(toasts()).toContain("error:Shiprocket didn't answer."));
      expect(screen.getByRole("button", { name: "Refresh tracking" })).toBeEnabled();
    });
  });

  describe("cancelling", () => {
    it("asks for a reason before cancelling", async () => {
      const { user } = await open();
      await user.click(screen.getByRole("button", { name: "Cancel shipment" }));
      const dialog = await screen.findByRole("dialog", { name: "Cancel this shipment?" });
      expect(dialog).toHaveTextContent("Shiprocket is told to cancel AWB 1234567890.");

      await user.click(within(dialog).getByRole("button", { name: "Cancel shipment" }));
      expect(within(dialog).getByText("Say why it's being cancelled.")).toBeInTheDocument();
      await user.type(within(dialog).getByLabelText(/^Reason/), "ab");
      expect(within(dialog).queryByText("Say why it's being cancelled.")).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Cancel shipment" }));
      expect(within(dialog).getByText("Say why it's being cancelled.")).toBeInTheDocument();
      expect(api.requests("POST", "/admin/shipments/12/cancel")).toHaveLength(0);
    });

    it("cancels with the trimmed reason and shows the cancelled shipment", async () => {
      const { user } = await open();
      api.post("/admin/shipments/12/cancel", shipment({ status: "cancelled", statusLabel: "Cancelled", actions: NONE }));
      await user.click(screen.getByRole("button", { name: "Cancel shipment" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText(/^Reason/), "  Customer asked  ");
      await user.click(within(dialog).getByRole("button", { name: "Cancel shipment" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.last("POST", "/admin/shipments/12/cancel")!.body).toEqual({ reason: "Customer asked" });
      expect(toasts()).toContain("success:Shipment cancelled.");
      expect(screen.getByText("Cancelled")).toBeInTheDocument();
      expect(within(actionsGroup()).queryByRole("button", { name: "Cancel shipment" })).not.toBeInTheDocument();
    });

    it("keeps the shipment when the dialog is dismissed", async () => {
      const { user } = await open();
      await user.click(screen.getByRole("button", { name: "Cancel shipment" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.requests("POST", "/admin/shipments/12/cancel")).toHaveLength(0);
    });

    it("closes and re-reads the shipment when it can no longer be cancelled", async () => {
      const { user } = await open();
      api.post("/admin/shipments/12/cancel", fail(409, "It has already been picked up.", "SHIPMENT_NOT_CANCELLABLE"));
      api.get("/admin/shipments/12", shipment({ status: "picked-up", statusLabel: "Picked up", actions: { ...NONE, refresh: true } }));
      await user.click(screen.getByRole("button", { name: "Cancel shipment" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText(/^Reason/), "Wrong address");
      await user.click(within(dialog).getByRole("button", { name: "Cancel shipment" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(toasts()).toContain("error:It has already been picked up.");
      await waitFor(() => expect(within(actionsGroup()).queryByRole("button", { name: "Cancel shipment" })).not.toBeInTheDocument());
      expect(api.requests("GET", "/admin/shipments/12")).toHaveLength(2);
    });

    it("stays open on any other failure", async () => {
      const { user } = await open();
      api.post("/admin/shipments/12/cancel", fail(502, "The courier didn't answer.", "COURIER_UNAVAILABLE"));
      await user.click(screen.getByRole("button", { name: "Cancel shipment" }));
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText(/^Reason/), "Wrong address");
      await user.click(within(dialog).getByRole("button", { name: "Cancel shipment" }));
      await waitFor(() => expect(toasts()).toContain("error:The courier didn't answer."));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel shipment" })).toBeEnabled();
    });
  });

  describe("editing the package", () => {
    it("checks every dimension for an API courier and saves the package", async () => {
      const { user } = await open(shipment({ actions: { ...NONE, editPackage: true } }));
      api.put("/admin/shipments/12/package", shipment({ package: { weightGrams: 950, lengthCm: 30, widthCm: 20, heightCm: 5, count: 1, type: "box" }, actions: { ...NONE, editPackage: true } }));
      await user.click(screen.getByRole("button", { name: "Edit package" }));
      const dialog = await screen.findByRole("dialog", { name: "Edit package" });
      expect(within(dialog).getByLabelText(/^Weight/)).toHaveValue("800");

      await user.clear(within(dialog).getByLabelText(/^Length/));
      await user.click(within(dialog).getByRole("button", { name: "Save package" }));
      expect(within(dialog).getByText("Required for this courier.")).toBeInTheDocument();
      expect(api.requests("PUT", "/admin/shipments/12/package")).toHaveLength(0);

      await user.type(within(dialog).getByLabelText(/^Length/), "30");
      await user.clear(within(dialog).getByLabelText(/^Weight/));
      await user.type(within(dialog).getByLabelText(/^Weight/), "950");
      await user.click(within(dialog).getByRole("button", { name: "Save package" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.last("PUT", "/admin/shipments/12/package")!.body).toEqual({
        package: { weightGrams: 950, lengthCm: 30, widthCm: 20, heightCm: 5, count: 1, type: "box" },
      });
      expect(screen.getByText("950 g · 30 × 20 × 5 cm · 1 package · box")).toBeInTheDocument();
      expect(toasts()).toContain("success:Package updated.");
    });

    it("needs only the weight for a manual courier", async () => {
      const manual = shipment({ provider: { code: "manual", name: "Manual" }, package: { weightGrams: 500, lengthCm: null, widthCm: null, heightCm: null, count: null, type: null }, actions: { ...NONE, editPackage: true } });
      const { user } = await open(manual);
      api.put("/admin/shipments/12/package", manual);
      await user.click(screen.getByRole("button", { name: "Edit package" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Save package" }));
      await waitFor(() => expect(api.last("PUT", "/admin/shipments/12/package")?.body).toEqual({ package: { weightGrams: 500 } }));
    });

    it("keeps the dialog open with the API's message when saving fails", async () => {
      const { user } = await open(shipment({ actions: { ...NONE, editPackage: true } }));
      api.put("/admin/shipments/12/package", fail(409, "The courier has confirmed it already.", "SHIPMENT_LOCKED"));
      await user.click(screen.getByRole("button", { name: "Edit package" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Save package" }));
      await waitFor(() => expect(toasts()).toContain("error:The courier has confirmed it already."));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  it("opens the manual event dialog from Record event", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Record event" }));
    expect(await screen.findByRole("dialog", { name: "Record a tracking event" })).toBeInTheDocument();
  });
});
