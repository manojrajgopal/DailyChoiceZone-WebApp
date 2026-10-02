import { describe, expect, it } from "vitest";

import { renderUI, screen, within } from "@/test/render";
import { shipmentEvent } from "@/test/shipping-fixtures";

import { TrackingTimeline, chronological } from "./TrackingTimeline";

describe("chronological", () => {
  it("orders events by when they happened, keeping arrival order for ties", () => {
    const events = [
      { id: "c", occurredAt: "2026-10-05T06:00:00" },
      { id: "a", occurredAt: "2026-10-03T06:00:00" },
      { id: "b1", occurredAt: "2026-10-04T06:00:00" },
      { id: "b2", occurredAt: "2026-10-04T06:00:00" },
    ];
    expect(chronological(events).map((event) => event.id)).toEqual(["a", "b1", "b2", "c"]);
    // The input is left alone.
    expect(events[0]!.id).toBe("c");
  });

  it("treats a timezone-less timestamp as UTC, the same as an explicit Z", () => {
    const events = [
      { id: "later", occurredAt: "2026-10-03T06:30:00" },
      { id: "earlier", occurredAt: "2026-10-03T06:00:00Z" },
    ];
    expect(chronological(events).map((event) => event.id)).toEqual(["earlier", "later"]);
  });
});

describe("TrackingTimeline", () => {
  it("says so when there are no events yet", () => {
    renderUI(<TrackingTimeline events={[]} />);
    expect(screen.getByText(/No tracking events yet/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("lists events oldest first, whatever order they arrived in, with location, source and the courier's own words", () => {
    renderUI(
      <TrackingTimeline
        events={[
          shipmentEvent({ id: 3, status: "out-for-delivery", label: "Out for delivery", providerStatus: "OFD", description: "", location: "", occurredAt: "2026-10-05T03:00:00", source: "poll" }),
          shipmentEvent({ id: 1, occurredAt: "2026-10-03T06:00:00" }),
          shipmentEvent({ id: 2, status: "in-transit", label: "In transit", providerStatus: "In transit", description: "Left the hub", location: "Hosur", occurredAt: "2026-10-04T06:00:00" }),
        ]}
      />,
    );
    const items = within(screen.getByRole("list", { name: "Tracking events" })).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".font-medium")?.textContent)).toEqual(["Picked up", "In transit", "Out for delivery"]);

    expect(items[0]).toHaveTextContent("Shipment picked up");
    expect(items[0]).toHaveTextContent("Bengaluru Hub");
    expect(items[0]).toHaveTextContent("Courier update");
    expect(items[0]).toHaveTextContent("“PICKED UP”");
    // The courier's words are not repeated when they match the title.
    expect(items[1]).not.toHaveTextContent("“In transit”");
    expect(items[2]).toHaveTextContent("Tracking check");
    expect(items[2]).toHaveTextContent("“OFD”");
  });

  it("shows who recorded a staff event and flags the ones hidden from the customer", () => {
    renderUI(
      <TrackingTimeline
        events={[
          shipmentEvent({ id: 1, source: "admin", actor: "ADM001", visible: false, providerStatus: "" }),
          shipmentEvent({ id: 2, source: "system", visible: true, providerStatus: "", occurredAt: "2026-10-04T06:00:00" }),
        ]}
      />,
    );
    const [first, second] = screen.getAllByRole("listitem");
    expect(first).toHaveTextContent("Recorded by staff · ADM001");
    expect(first).toHaveTextContent("Hidden from the customer");
    expect(second).toHaveTextContent("Automatic");
    expect(second).not.toHaveTextContent("Hidden from the customer");
  });

  it("falls back from the label to the status, then the courier's status, then 'Update'", () => {
    renderUI(
      <TrackingTimeline
        events={[
          shipmentEvent({ id: 1, label: "", status: "delivery-attempted", occurredAt: "2026-10-03T01:00:00" }),
          shipmentEvent({ id: 2, label: "", status: "", providerStatus: "RTO INITIATED", occurredAt: "2026-10-03T02:00:00" }),
          shipmentEvent({ id: 3, label: "", status: "", providerStatus: "", occurredAt: "2026-10-03T03:00:00", source: "unknown-source" as "poll" }),
        ]}
      />,
    );
    const titles = screen.getAllByRole("listitem").map((item) => item.querySelector(".font-medium")?.textContent);
    expect(titles[0]).toMatch(/delivery attempted/i);
    expect(titles[1]).toBe("RTO INITIATED");
    expect(titles[2]).toBe("Update");
    // An unknown source is shown as it is.
    expect(screen.getAllByRole("listitem")[2]).toHaveTextContent("unknown-source");
  });
});
