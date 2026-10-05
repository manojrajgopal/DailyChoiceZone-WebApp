import { describe, expect, it } from "vitest";

import { api, fail, networkError } from "@/test/api";
import { idPreview, lookupBackend } from "@/test/lookup-fixtures";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { shipmentRow } from "@/test/shipping-fixtures";
import { page } from "@/test/suppliers-fixtures";

import { AdminShipmentsView } from "./AdminShipmentsView";

/** The page re-reads the address bar on render; the router stand-in has already followed the replace. */
function follow(rerender: (ui: React.ReactElement) => void) {
  rerender(<AdminShipmentsView />);
}

const lastQuery = () => api.last("GET", "/admin/shipments")!.query;

describe("AdminShipmentsView", () => {
  describe("loading, error and empty", () => {
    it("shows placeholder rows while the list loads", () => {
      api.get("/admin/shipments", () => new Promise(() => undefined));
      api.get("/admin/shipping/providers", []);
      const { container } = renderUI(<AdminShipmentsView />);
      expect(screen.getByRole("heading", { name: "Shipments" })).toBeInTheDocument();
      expect(container.querySelectorAll("tbody .animate-pulse").length).toBeGreaterThan(0);
      expect(screen.queryByRole("link", { name: /DCZ-SH/ })).not.toBeInTheDocument();
    });

    it.each([
      ["a server error", fail(500, "Database down", "INTERNAL")],
      ["a network failure", networkError()],
    ])("offers a retry on %s, and the retry loads the list", async (_, reply) => {
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()]));
      api.once("GET", "/admin/shipments", reply);
      const { user } = renderUI(<AdminShipmentsView />);

      expect(await screen.findByText("This didn’t load.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("link", { name: "DCZ-SH-2026-000012" })).toBeInTheDocument();
      expect(api.requests("GET", "/admin/shipments")).toHaveLength(2);
    });

    it("says there are no shipments yet when nothing is filtered", async () => {
      api.get("/admin/shipments", page([]));
      api.get("/admin/shipping/providers", []);
      renderUI(<AdminShipmentsView />);
      expect(await screen.findByText("No shipments yet")).toBeInTheDocument();
      expect(screen.getByText(/created from an order's page once the order is packed/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Clear filters/ })).not.toBeInTheDocument();
      // No pager for an empty list.
      expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    });

    it("says nothing matches when a filter is on", async () => {
      setLocation("/admin/shipments?q=DCZ-SH-2026-999999");
      api.get("/admin/shipments", page([]));
      api.get("/admin/shipping/providers", []);
      renderUI(<AdminShipmentsView />);
      expect(await screen.findByText("No shipments match")).toBeInTheDocument();
      expect(screen.getByText("Try a different filter or search.")).toBeInTheDocument();
    });
  });

  describe("the pipeline around the list", () => {
    const pipeline = (overrides = {}) => ({
      readyToShip: {
        count: 2,
        items: [
          { orderId: "ORD050", orderNumber: "DCZ10050", customerName: "Ravi K", status: "packed", statusLabel: "Packed",
            paymentStatus: "cod-pending", placedAt: "2026-10-01T05:00:00", packedAt: "2026-10-02T05:00:00",
            packingJobId: 7, packageCount: 1 },
        ],
      },
      missingShipments: {
        count: 1,
        items: [
          { orderId: "ORD030", orderNumber: "DCZ10030", customerName: "Meera", status: "shipped", statusLabel: "Shipped",
            paymentStatus: "paid", placedAt: "2026-09-01T05:00:00", packedAt: null, packingJobId: null, packageCount: 0 },
        ],
      },
      deliveredWithoutShipment: 126,
      couriersActive: false,
      ...overrides,
    });

    it("counts packed orders ready for a shipment instead of pretending there is nothing", async () => {
      api.get("/admin/shipments", page([]));
      api.get("/admin/shipments/pipeline", pipeline());
      renderUI(<AdminShipmentsView />);
      expect(await screen.findByText("2 orders ready to create shipment")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Create shipment/ })).toHaveAttribute("href", "/admin/orders/detail?id=ORD050");
      expect(await screen.findByText(/2 packed orders are ready — create their shipments/)).toBeInTheDocument();
    });

    it("says when no courier is on, and lists orders missing a shipment record", async () => {
      api.get("/admin/shipments", page([]));
      api.get("/admin/shipments/pipeline", pipeline());
      renderUI(<AdminShipmentsView />);
      expect(await screen.findByText(/No courier is switched on/)).toBeInTheDocument();
      expect(screen.getByText("1 order was marked dispatched without a shipment record")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "#DCZ10030 (shipped)" })).toHaveAttribute("href", "/admin/orders/detail?id=ORD030");
      expect(screen.getByText(/126 delivered orders have no shipment record/)).toBeInTheDocument();
    });

    it("shows nothing extra when everything is in order", async () => {
      api.get("/admin/shipments", page([shipmentRow()]));
      api.get("/admin/shipments/pipeline", pipeline({
        readyToShip: { count: 0, items: [] }, missingShipments: { count: 0, items: [] },
        deliveredWithoutShipment: 0, couriersActive: true,
      }));
      renderUI(<AdminShipmentsView />);
      expect(await screen.findByRole("link", { name: "DCZ-SH-2026-000012" })).toBeInTheDocument();
      expect(screen.queryByText(/ready to create shipment/)).not.toBeInTheDocument();
    });
  });

  describe("next step", () => {
    it("offers the server's next step and asks for a reason only when it needs one", async () => {
      signIn("admin", "adm");
      api.get("/admin/shipments", page([shipmentRow({
        status: "ready-for-pickup", statusLabel: "Ready for pickup",
        nextAction: { status: "pickup-scheduled", label: "Pickup scheduled", action: "Schedule pickup", kind: "forward",
          requiresReason: false },
      })]));
      api.post("/admin/shipments/12/status", { id: 12, shipmentNumber: "DCZ-SH-2026-000012", status: "pickup-scheduled",
        statusLabel: "Pickup scheduled" });
      const { user } = renderUI(<AdminShipmentsView />);
      await user.click(await screen.findByRole("button", { name: "Schedule pickup" }));
      const dialog = screen.getByRole("dialog", { name: "Schedule pickup?" });
      expect(within(dialog).queryByLabelText(/^Reason/)).not.toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Schedule pickup" }));
      await waitFor(() => expect(api.last("POST", "/admin/shipments/12/status")!.body).toEqual({
        status: "pickup-scheduled", reason: "",
      }));
    });

    it("shows the server's refusal in the dialog", async () => {
      api.get("/admin/shipments", page([shipmentRow({
        nextAction: { status: "at-destination-hub", label: "At destination hub", action: "Reached destination hub",
          kind: "forward", requiresReason: false },
      })]));
      api.post("/admin/shipments/12/status",
        fail(409, "Shipment cannot move from Delivered to At destination hub.", "INVALID_SHIPMENT_TRANSITION"));
      const { user } = renderUI(<AdminShipmentsView />);
      await user.click(await screen.findByRole("button", { name: "Reached destination hub" }));
      const dialog = screen.getByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Reached destination hub" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Shipment cannot move from Delivered");
    });
  });

  describe("rows", () => {
    it("lists shipments from the API with the admin token, linking to the shipment and its order", async () => {
      signIn("admin", "adm");
      api.get("/admin/shipping/providers", []);
      api.get(
        "/admin/shipments",
        page(
          [
            shipmentRow(),
            shipmentRow({
              id: 13,
              shipmentNumber: "DCZ-SH-2026-000013",
              status: "pending",
              statusLabel: "Pending",
              orderId: "ORD/43",
              orderNumber: "DCZ10043",
              customerName: "",
              courierName: "",
              awb: "",
              requestStatus: "failed",
              lastError: "Pincode not serviceable",
              expectedDeliveryAt: null,
            }),
            shipmentRow({ id: 14, shipmentNumber: "DCZ-SH-2026-000014", requestStatus: "pending", status: "ready-for-pickup", statusLabel: "Ready for pickup" }),
          ],
          { counts: { "in-transit": 1, pending: 1, "ready-for-pickup": 1 } },
        ),
      );
      renderUI(<AdminShipmentsView />);

      const link = await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });
      expect(link).toHaveAttribute("href", "/admin/shipments/detail?id=12");
      expect(screen.getAllByRole("link", { name: "#DCZ10042" })[0]).toHaveAttribute("href", "/admin/orders/detail?id=ORD042");
      expect(screen.getByRole("link", { name: "#DCZ10043" })).toHaveAttribute("href", "/admin/orders/detail?id=ORD%2F43");

      const rows = screen.getAllByRole("row");
      expect(within(rows[1]!).getByText("Asha Rao")).toBeInTheDocument();
      expect(within(rows[1]!).getByText("Delhivery Surface")).toBeInTheDocument();
      expect(within(rows[1]!).getByText("1234567890")).toBeInTheDocument();
      expect(within(rows[1]!).getByText("In transit")).toBeInTheDocument();
      expect(within(rows[1]!).getByText("9 Oct 2026")).toBeInTheDocument();
      expect(within(rows[1]!).getByText("2 Oct 2026")).toBeInTheDocument();

      // Blank fields show a dash (and no next step), and a failed courier request says why.
      expect(within(rows[2]!).getAllByText("—")).toHaveLength(5);
      expect(within(rows[2]!).getByText("Courier request failed: Pincode not serviceable")).toBeInTheDocument();
      expect(within(rows[3]!).getByText("Waiting for the courier")).toBeInTheDocument();

      expect(api.last("GET", "/admin/shipments")!.headers.authorization).toBe("Bearer adm");
    });

    it("shows the counts on the status tabs, the total on All", async () => {
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()], { counts: { "in-transit": 4, delivered: 6 } }));
      renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });
      expect(screen.getByRole("tab", { name: "All 10" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByRole("tab", { name: "In transit 4" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Delivered 6" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Cancelled 0" })).toBeInTheDocument();
    });
  });

  describe("filters in the address bar", () => {
    it("sends the filters it finds in the URL", async () => {
      setLocation("/admin/shipments?status=delivered&q=1234567890&order=DCZ10042&provider=manual&from=2026-10-01&to=2026-10-02&page=2&pageSize=50");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()], { page: 2, total: 60, totalPages: 2 }));
      renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });

      const query = lastQuery();
      expect(Object.fromEntries(query.entries())).toEqual({
        status: "delivered",
        q: "1234567890",
        order: "DCZ10042",
        provider: "manual",
        from: "2026-10-01",
        to: "2026-10-02",
        page: "2",
        pageSize: "50",
      });
      expect(screen.getByRole("tab", { name: /^Delivered/ })).toHaveAttribute("aria-selected", "true");
      // Each ID filtering the list shows as a chip that can be removed.
      expect(screen.getByRole("group", { name: "Filtered by Shipment ID or AWB 1234567890" })).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Filtered by Order ID DCZ10042" })).toBeInTheDocument();
    });

    it("filters by status from the tabs, back on page 1", async () => {
      setLocation("/admin/shipments?page=3");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", (req) => page(req.query.get("status") === "delivered" ? [] : [shipmentRow()]));
      const { user, rerender } = renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });

      await user.click(screen.getByRole("tab", { name: /^Delivered/ }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/shipments?status=delivered", { scroll: false });

      follow(rerender);
      expect(await screen.findByText("No shipments match")).toBeInTheDocument();
      expect(lastQuery().get("status")).toBe("delivered");
      expect(lastQuery().get("page")).toBe("1");
    });

    it("filters by a Shipment ID chosen from the ID suggestions, not by free text", async () => {
      setLocation("/admin/shipments");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()]));
      api.get("/admin/lookup/shipment", { items: [{ id: "DCZ-SH-2026-000012" }], hasMore: false });
      const { user, rerender } = renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });

      // The box names the ID it takes; there is no name/email search and no courier-name box.
      const box = screen.getByRole("combobox", { name: "Shipment ID or AWB" });
      expect(box).toHaveAttribute("placeholder", "Search Shipment ID…");
      expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Filter by courier")).not.toBeInTheDocument();

      await user.type(box, "SH-2026-0000");
      await user.click(await screen.findByRole("option", { name: "DCZ-SH-2026-000012" }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/shipments?q=DCZ-SH-2026-000012", { scroll: false });
      expect(api.last("GET", "/admin/lookup/shipment")!.query.get("q")).toBe("SH-2026-0000");

      follow(rerender);
      await waitFor(() => expect(lastQuery().get("q")).toBe("DCZ-SH-2026-000012"));
    });

    it("filters by an Order ID, and removing the chip clears it", async () => {
      setLocation("/admin/shipments");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()]));
      api.get("/admin/lookup/order", { items: [{ id: "DCZ10042" }], hasMore: false });
      const { user, rerender } = renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });

      await user.type(screen.getByRole("combobox", { name: "Order ID" }), "DCZ100");
      await user.click(await screen.findByRole("option", { name: "DCZ10042" }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/shipments?order=DCZ10042", { scroll: false });

      follow(rerender);
      await waitFor(() => expect(lastQuery().get("order")).toBe("DCZ10042"));
      await user.click(screen.getByRole("button", { name: "Remove Order ID filter" }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/shipments", { scroll: false });
    });

    it("filters by courier code, picked from the ID lookup", async () => {
      setLocation("/admin/shipments");
      api.get("/admin/shipments", page([shipmentRow()]));
      lookupBackend("courier", [
        idPreview("courier", "shiprocket", { title: "Shiprocket", volatile: false }),
        idPreview("courier", "manual", { title: "Manual", volatile: false }),
      ]);
      const { user } = renderUI(<AdminShipmentsView />);

      const field = await screen.findByRole("combobox", { name: "Courier code" });
      await user.type(field, "Manual courier");
      expect((await screen.findAllByText("No matching IDs found.")).length).toBeGreaterThan(0);
      await user.clear(field);
      await user.type(field, "ma");
      await user.click(await screen.findByRole("option", { name: "manual" }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/shipments?provider=manual", { scroll: false });
      // The provider list is never downloaded to build a dropdown of names.
      expect(api.requests("GET", "/admin/shipping/providers")).toHaveLength(0);
    });

    it("shows the courier code it is filtering by, with a way to remove it", async () => {
      setLocation("/admin/shipments?provider=manual");
      api.get("/admin/shipments", page([shipmentRow()]));
      const { user } = renderUI(<AdminShipmentsView />);
      expect(await screen.findByRole("group", { name: "Filtered by Courier code manual" })).toBeInTheDocument();
      await waitFor(() => expect(api.last("GET", "/admin/shipments")!.query.get("provider")).toBe("manual"));
      await user.click(screen.getByRole("button", { name: "Remove Courier code filter" }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/shipments", { scroll: false });
    });

    it("filters by date and warns when the range is back to front", async () => {
      setLocation("/admin/shipments?from=2026-10-05&to=2026-10-01");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([]));
      renderUI(<AdminShipmentsView />);
      expect(await screen.findByRole("alert")).toHaveTextContent("The start date is after the end date");
      expect(screen.getByLabelText("Created from")).toHaveValue("2026-10-05");
      expect(screen.getByLabelText("Created to")).toHaveValue("2026-10-01");
    });

    it("clears every filter but keeps the page size", async () => {
      setLocation("/admin/shipments?status=delivered&q=DCZ10042&pageSize=50");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()]));
      const { user } = renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });
      await user.click(screen.getByRole("button", { name: /Clear filters/ }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/shipments?pageSize=50", { scroll: false });
    });
  });

  describe("paging and refresh", () => {
    it("shows the range and moves between pages", async () => {
      setLocation("/admin/shipments");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", (req) =>
        page([shipmentRow({ id: Number(req.query.get("page")) * 100 })], { page: Number(req.query.get("page")), total: 60, totalPages: 3 }),
      );
      const { user, rerender } = renderUI(<AdminShipmentsView />);
      expect(await screen.findByText("Showing 1–25 of 60")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Next page" }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/shipments?page=2", { scroll: false });
      follow(rerender);
      expect(await screen.findByText("Showing 26–50 of 60")).toBeInTheDocument();
      expect(lastQuery().get("page")).toBe("2");
    });

    it("re-reads the list on Refresh", async () => {
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()]));
      const { user } = renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });
      await user.click(screen.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(api.requests("GET", "/admin/shipments")).toHaveLength(2));
      expect(screen.getByRole("link", { name: "Courier settings" })).toHaveAttribute("href", "/admin/settings/couriers");
    });
  });
});
