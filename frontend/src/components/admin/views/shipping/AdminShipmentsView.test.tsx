import { describe, expect, it } from "vitest";

import { api, fail, networkError } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { providerConfig, manualProvider, shipmentRow } from "@/test/shipping-fixtures";
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
      expect(screen.getByText(/Create one from an order's page/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Clear filters/ })).not.toBeInTheDocument();
      // No pager for an empty list.
      expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    });

    it("says nothing matches when a filter is on", async () => {
      setLocation("/admin/shipments?q=nobody");
      api.get("/admin/shipments", page([]));
      api.get("/admin/shipping/providers", []);
      renderUI(<AdminShipmentsView />);
      expect(await screen.findByText("No shipments match")).toBeInTheDocument();
      expect(screen.getByText("Try a different filter or search.")).toBeInTheDocument();
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

      // Blank fields show a dash, and a failed courier request says why.
      expect(within(rows[2]!).getAllByText("—")).toHaveLength(4);
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
      setLocation("/admin/shipments?status=delivered&q=asha&courier=Delhivery&provider=manual&from=2026-10-01&to=2026-10-02&page=2&pageSize=50");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()], { page: 2, total: 60, totalPages: 2 }));
      renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });

      const query = lastQuery();
      expect(Object.fromEntries(query.entries())).toEqual({
        status: "delivered",
        q: "asha",
        courier: "Delhivery",
        provider: "manual",
        from: "2026-10-01",
        to: "2026-10-02",
        page: "2",
        pageSize: "50",
      });
      expect(screen.getByRole("tab", { name: /^Delivered/ })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByLabelText("Search shipments")).toHaveValue("asha");
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

    it("searches a moment after typing stops", async () => {
      setLocation("/admin/shipments");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()]));
      const { user, rerender } = renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });

      await user.type(screen.getByLabelText("Search shipments"), "  1234567890 ");
      expect(router.replace).not.toHaveBeenCalled();
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin/shipments?q=1234567890", { scroll: false }));
      expect(router.replace).toHaveBeenCalledTimes(1);

      follow(rerender);
      await waitFor(() => expect(lastQuery().get("q")).toBe("1234567890"));
    });

    it("filters by courier name", async () => {
      setLocation("/admin/shipments");
      api.get("/admin/shipping/providers", []);
      api.get("/admin/shipments", page([shipmentRow()]));
      const { user } = renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });
      await user.type(screen.getByLabelText("Filter by courier"), "DTDC");
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/admin/shipments?courier=DTDC", { scroll: false }));
    });

    it("offers a provider filter only once the providers load", async () => {
      setLocation("/admin/shipments");
      api.get("/admin/shipping/providers", [providerConfig(), manualProvider()]);
      api.get("/admin/shipments", page([shipmentRow()]));
      const { user } = renderUI(<AdminShipmentsView />);

      const select = await screen.findByRole("combobox", { name: "Provider" });
      expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["All providers", "Shiprocket", "Manual"]);
      await user.selectOptions(select, "manual");
      expect(router.replace).toHaveBeenLastCalledWith("/admin/shipments?provider=manual", { scroll: false });
    });

    it("leaves the provider filter out when the providers can't be read", async () => {
      api.get("/admin/shipping/providers", fail(403, "Forbidden", "FORBIDDEN"));
      api.get("/admin/shipments", page([shipmentRow()]));
      renderUI(<AdminShipmentsView />);
      await screen.findByRole("link", { name: "DCZ-SH-2026-000012" });
      expect(screen.queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument();
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
      setLocation("/admin/shipments?status=delivered&q=asha&pageSize=50");
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
