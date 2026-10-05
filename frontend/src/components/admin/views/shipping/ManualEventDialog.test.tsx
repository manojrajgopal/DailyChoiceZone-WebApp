import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, fail } from "@/test/api";
import { fireEvent, renderUI, screen, waitFor, within } from "@/test/render";
import { shipment } from "@/test/shipping-fixtures";
import { useToastStore } from "@/store/toastStore";

import { ManualEventDialog } from "./ManualEventDialog";

const toasts = () => useToastStore.getState().toasts.map((toast) => `${toast.tone}:${toast.message}`);

/** The browser's "now", as a datetime-local value. */
function localValue(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Out for delivery: the server allows delivered, or an exception with a reason. */
const OUT = shipment({
  status: "out-for-delivery",
  statusLabel: "Out for delivery",
  transitions: [
    { status: "delivered", label: "Delivered", action: "Mark delivered", kind: "forward", requiresReason: false },
    { status: "delivery-attempted", label: "Delivery attempted", action: "Delivery attempted", kind: "exception", requiresReason: true },
    { status: "delivery-failed", label: "Delivery failed", action: "Delivery failed", kind: "exception", requiresReason: true },
  ],
});

function setup() {
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  const view = renderUI(<ManualEventDialog shipment={OUT} open onOpenChange={onOpenChange} onSaved={onSaved} />);
  const dialog = screen.getByRole("dialog", { name: "Record a tracking event" });
  return { ...view, dialog, onOpenChange, onSaved };
}

describe("ManualEventDialog", () => {
  const NOW = new Date("2026-10-04T10:30:00Z");

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers only the next steps the server allows, plus a note at the current status, and starts at now", () => {
    const { dialog } = setup();
    const options = within(within(dialog).getByLabelText(/^What happened/)).getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual([
      "Choose a status",
      "Out for delivery — tracking note, no move",
      "Mark delivered",
      "Delivery attempted (needs a reason)",
      "Delivery failed (needs a reason)",
    ]);
    expect(within(dialog).getByLabelText(/^When/)).toHaveValue(localValue(NOW));
    expect(within(dialog).getByRole("switch")).toBeChecked();
  });

  it("asks for a status and refuses a time in the future", async () => {
    const { user, dialog } = setup();
    const when = within(dialog).getByLabelText(/^When/);
    fireEvent.change(when, { target: { value: localValue(new Date(NOW.getTime() + 60 * 60_000)) } });
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText("Choose what happened.")).toBeInTheDocument();
    expect(within(dialog).getByText("This can't be in the future.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Record event" })).not.toBeInTheDocument();
  });

  it("asks when it happened", async () => {
    const { user, dialog } = setup();
    fireEvent.change(within(dialog).getByLabelText(/^When/), { target: { value: "" } });
    await user.selectOptions(within(dialog).getByLabelText(/^What happened/), "delivered");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText("Enter when it happened.")).toBeInTheDocument();
  });

  it("limits the description and location", async () => {
    const { user, dialog } = setup();
    await user.selectOptions(within(dialog).getByLabelText(/^What happened/), "delivered");
    await user.click(within(dialog).getByLabelText(/^Location/));
    await user.paste("x".repeat(121));
    await user.click(within(dialog).getByLabelText(/^Description/));
    await user.paste("y".repeat(501));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText("At most 120 characters.")).toBeInTheDocument();
    expect(within(dialog).getByText("At most 500 characters.")).toBeInTheDocument();
  });

  it("confirms, then records the event as UTC and hands back the updated shipment", async () => {
    const updated = shipment({ status: "delivered", statusLabel: "Delivered" });
    api.post("/admin/shipments/12/events", updated);
    const { user, dialog, onSaved, onOpenChange } = setup();

    await user.selectOptions(within(dialog).getByLabelText(/^What happened/), "delivered");
    await user.type(within(dialog).getByLabelText(/^Location/), "  Mysuru  ");
    await user.type(within(dialog).getByLabelText(/^Description/), " Handed to the customer ");
    await user.click(within(dialog).getByRole("switch"));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));

    expect(dialog).toHaveTextContent("Record Delivered for DCZ-SH-2026-000012?");
    expect(api.requests("POST", "/admin/shipments/12/events")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Record event" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(api.last("POST", "/admin/shipments/12/events")!.body).toEqual({
      status: "delivered",
      description: "Handed to the customer",
      location: "Mysuru",
      occurredAt: new Date(localValue(NOW)).toISOString(),
      visible: false,
      reason: "",
    });
    expect(toasts()).toContain("success:Recorded “Delivered”.");
  });

  it("goes back to the form from the confirmation", async () => {
    const { user, dialog } = setup();
    await user.selectOptions(within(dialog).getByLabelText(/^What happened/), "delivered");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(within(dialog).getByLabelText(/^What happened/)).toHaveValue("delivered");
  });

  it("asks for a reason for an exception and sends it", async () => {
    api.post("/admin/shipments/12/events", shipment({ status: "delivery-attempted" }));
    const { user, dialog } = setup();
    await user.selectOptions(within(dialog).getByLabelText(/^What happened/), "delivery-attempted");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText("Give a short reason (at least 3 characters).")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/^Reason/), "Customer not home");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(within(dialog).getByRole("button", { name: "Record event" }));
    await waitFor(() => expect(api.last("POST", "/admin/shipments/12/events")!.body).toMatchObject({
      status: "delivery-attempted", reason: "Customer not home",
    }));
  });

  it("returns to the form with the API's message when recording fails", async () => {
    api.post("/admin/shipments/12/events", fail(409, "A delivered shipment can't move back.", "INVALID_TRANSITION"));
    const { user, dialog, onSaved } = setup();
    await user.selectOptions(within(dialog).getByLabelText(/^What happened/), "delivered");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.click(within(dialog).getByRole("button", { name: "Record event" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A delivered shipment can't move back.");
    expect(within(dialog).getByLabelText(/^What happened/)).toHaveValue("delivered");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("closes on Cancel", async () => {
    const { user, dialog, onOpenChange } = setup();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
