import { describe, expect, it } from "vitest";

import { api, fail, networkError } from "@/test/api";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { customerShipment } from "@/test/shipping-fixtures";

import { OrderShipments } from "./OrderShipments";

describe("OrderShipments", () => {
  describe("loading, failure and nothing to show", () => {
    it("asks for the signed-in customer's shipments of this order and shows a placeholder meanwhile", async () => {
      signIn("customer", "cus");
      api.get("/orders/DCZ%2F10042/shipments", () => new Promise(() => undefined));
      renderUI(<OrderShipments orderNumber="DCZ/10042" />);
      expect(screen.getByRole("status", { name: "Loading shipment" })).toBeInTheDocument();
      await waitFor(() => expect(api.calls).toHaveLength(1));
      // The order number is escaped into the path and the customer's token is sent.
      expect(api.calls[0]!.url).toContain("/orders/DCZ%2F10042/shipments");
      expect(api.calls[0]!.headers.authorization).toBe("Bearer cus");
    });

    it("shows nothing before the order has been handed to a courier", async () => {
      api.get("/orders/DCZ10042/shipments", []);
      const { container } = renderUI(<OrderShipments orderNumber="DCZ10042" />);
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it.each([
      ["a server error", fail(500)],
      ["a network failure", networkError()],
    ])("offers a retry on %s", async (_, reply) => {
      api.get("/orders/DCZ10042/shipments", [customerShipment()]);
      api.once("GET", "/orders/DCZ10042/shipments", reply);
      const { user } = renderUI(<OrderShipments orderNumber="DCZ10042" />);
      expect(await screen.findByText(/Tracking details couldn’t load just now/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText("In transit")).toBeInTheDocument();
    });
  });

  describe("a shipment", () => {
    it("shows the courier, tracking number, expected date and the latest update", async () => {
      api.get("/orders/DCZ10042/shipments", [customerShipment()]);
      renderUI(<OrderShipments orderNumber="DCZ10042" />);

      expect(await screen.findByRole("heading", { name: "Shipment" })).toBeInTheDocument();
      expect(screen.getByText("In transit")).toBeInTheDocument();
      expect(screen.getByText(/Delhivery Surface · Surface · Tracking number/)).toBeInTheDocument();
      expect(screen.getByText("1234567890")).toBeInTheDocument();
      expect(screen.getByText("Expected by 9 Oct 2026")).toBeInTheDocument();
      expect(screen.getByText(/^Latest: In transit, Hosur · /)).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /courier’s site/ })).not.toBeInTheDocument();
    });

    it("shows the tracking history on request, oldest first whatever order it arrives in", async () => {
      api.get("/orders/DCZ10042/shipments", [
        customerShipment({
          events: [
            { status: "out-for-delivery", label: "Out for delivery", description: "Out for delivery", location: "Mysuru", occurredAt: "2026-10-05T03:00:00", source: "courier" },
            { status: "picked-up", label: "Picked up", description: "Shipment picked up", location: "Bengaluru Hub", occurredAt: "2026-10-03T06:00:00", source: "courier" },
            { status: "in-transit", label: "In transit", description: "Left the hub", location: "Hosur", occurredAt: "2026-10-04T06:00:00", source: "store" },
          ],
        }),
      ]);
      const { user } = renderUI(<OrderShipments orderNumber="DCZ10042" />);

      const toggle = await screen.findByRole("button", { name: "Show tracking history (3)" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("list", { name: "Tracking history" })).not.toBeInTheDocument();
      expect(screen.getByText(/^Latest: Out for delivery, Mysuru/)).toBeInTheDocument();

      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      const history = screen.getByRole("list", { name: "Tracking history" });
      expect(toggle).toHaveAttribute("aria-controls", history.id);
      const items = within(history).getAllByRole("listitem");
      expect(items.map((item) => item.querySelector(".font-medium")?.textContent)).toEqual(["Picked up", "In transit", "Out for delivery"]);
      expect(items[0]).toHaveTextContent("Shipment picked up");
      expect(items[0]).toHaveTextContent("Bengaluru Hub");
      expect(items[1]).toHaveTextContent("Left the hub");
      // A description that only repeats the label isn't shown twice.
      expect(within(items[2]!).getAllByText("Out for delivery")).toHaveLength(1);
      expect(screen.queryByText(/^Latest:/)).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Hide tracking history" }));
      expect(screen.queryByRole("list", { name: "Tracking history" })).not.toBeInTheDocument();
    });

    it("never shows internal or technical details, even if the API sent them", async () => {
      const leaky = {
        ...customerShipment(),
        id: 9876,
        provider: { code: "shiprocket", name: "Shiprocket-internal" },
        providerShipmentId: "PSID-55501",
        providerOrderId: "POID-44401",
        courierCode: "CC-777",
        technical: { requestStatus: "failed", lastError: "SECRET upstream stack trace", retryCount: 3 },
        label: { available: true, url: "https://labels.example/secret.pdf" },
        createdBy: "ADM001",
        events: [
          {
            ...customerShipment().events[0]!,
            id: 1,
            providerStatus: "RAW-COURIER-CODE-PKD",
            actor: "ADM-STAFF-42",
            visible: false,
            receivedAt: "2026-10-03T06:01:00",
          },
        ],
      };
      api.get("/orders/DCZ10042/shipments", [leaky]);
      const { user, container } = renderUI(<OrderShipments orderNumber="DCZ10042" />);
      await user.click(await screen.findByRole("button", { name: /Show tracking history/ }));

      const text = container.textContent ?? "";
      for (const secret of [
        "Shiprocket-internal",
        "PSID-55501",
        "POID-44401",
        "CC-777",
        "SECRET upstream stack trace",
        "failed",
        "ADM001",
        "RAW-COURIER-CODE-PKD",
        "ADM-STAFF-42",
        "9876",
        "Courier update",
        "Recorded by staff",
        "Hidden from the customer",
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(container.querySelector('a[href*="labels.example"]')).toBeNull();
      // What the customer is meant to see is there.
      expect(text).toContain("Picked up");
      expect(text).toContain("1234567890");
    });

    it("links to the courier's own tracking page in a new tab", async () => {
      api.get("/orders/DCZ10042/shipments", [customerShipment({ trackingUrl: "https://track.example/1234567890" })]);
      renderUI(<OrderShipments orderNumber="DCZ10042" />);
      const link = await screen.findByRole("link", { name: /Track on the courier’s site/ });
      expect(link).toHaveAttribute("href", "https://track.example/1234567890");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    });

    it("shows the delivery date once delivered instead of the expected one", async () => {
      api.get("/orders/DCZ10042/shipments", [customerShipment({ status: "delivered", statusLabel: "Delivered", deliveredAt: "2026-10-06T08:00:00" })]);
      renderUI(<OrderShipments orderNumber="DCZ10042" />);
      expect(await screen.findByText("Delivered 6 Oct 2026")).toBeInTheDocument();
      expect(screen.queryByText(/^Expected by/)).not.toBeInTheDocument();
    });

    it("says updates will follow when there are no events yet, and copes with no courier details", async () => {
      api.get("/orders/DCZ10042/shipments", [customerShipment({ status: "ready-for-pickup", statusLabel: "Ready for pickup", events: [], courierName: "", service: "", awb: "", expectedDeliveryAt: null })]);
      renderUI(<OrderShipments orderNumber="DCZ10042" />);
      expect(await screen.findByText("Tracking updates will appear here once the courier picks it up.")).toBeInTheDocument();
      expect(screen.getByText("Courier")).toBeInTheDocument();
      expect(screen.queryByText(/Tracking number/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /tracking history/ })).not.toBeInTheDocument();
    });
  });

  describe("more than one shipment", () => {
    it("lists the live one first and keeps a cancelled one, without an expected date", async () => {
      api.get("/orders/DCZ10042/shipments", [
        customerShipment({ shipmentNumber: "DCZ-SH-2026-000001", status: "cancelled", statusLabel: "Cancelled", events: [], awb: "OLD-AWB-1" }),
        customerShipment({ shipmentNumber: "DCZ-SH-2026-000002" }),
      ]);
      renderUI(<OrderShipments orderNumber="DCZ10042" />);

      const section = await screen.findByRole("region", { name: "Shipments" });
      const cards = within(section).getAllByRole("listitem");
      expect(cards).toHaveLength(2);
      expect(cards[0]).toHaveTextContent("In transit");
      expect(cards[1]).toHaveTextContent("Cancelled");
      expect(cards[1]).toHaveTextContent("This shipment was cancelled.");
      expect(cards[1]).not.toHaveTextContent("Expected by");
      expect(cards[0]).toHaveTextContent("Expected by 9 Oct 2026");
    });
  });
});
