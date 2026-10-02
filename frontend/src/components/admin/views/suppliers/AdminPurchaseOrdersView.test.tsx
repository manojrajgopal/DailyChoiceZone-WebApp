import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { router, setLocation } from "@/test/navigation";
import { renderUI, screen, signIn, waitFor, within } from "@/test/render";
import { page, poListItem, supplier } from "@/test/suppliers-fixtures";

import { AdminPurchaseOrdersView } from "./AdminPurchaseOrdersView";

const lastQuery = () => api.last("GET", "/admin/purchase-orders")!.query;

function suppliers() {
  api.get("/admin/suppliers", page([supplier(), supplier({ id: "SUP002", name: "Blue Looms", code: "BLUE" })]));
}

describe("AdminPurchaseOrdersView", () => {
  describe("loading, error, empty and access", () => {
    it("shows placeholder rows while loading", () => {
      suppliers();
      api.get("/admin/purchase-orders", () => new Promise(() => undefined));
      const { container } = renderUI(<AdminPurchaseOrdersView />);
      expect(container.querySelectorAll("tbody .animate-pulse").length).toBeGreaterThan(0);
    });

    it("offers a retry when the list doesn't load", async () => {
      suppliers();
      api.get("/admin/purchase-orders", page([poListItem()]));
      api.once("GET", "/admin/purchase-orders", fail(500));
      const { user } = renderUI(<AdminPurchaseOrdersView />);
      await user.click(await screen.findByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("link", { name: "DCZ-PO-2026-000001" })).toBeInTheDocument();
    });

    it("explains a missing purchasing permission", async () => {
      suppliers();
      api.get("/admin/purchase-orders", fail(403, "Forbidden", "FORBIDDEN"));
      renderUI(<AdminPurchaseOrdersView />);
      expect(await screen.findByText("Your role doesn't include purchasing")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /New purchase order/ })).not.toBeInTheDocument();
    });

    it("invites raising the first purchase order", async () => {
      suppliers();
      api.get("/admin/purchase-orders", page([]));
      renderUI(<AdminPurchaseOrdersView />);
      expect(await screen.findByText("No purchase orders yet")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Raise a purchase order" })).toHaveAttribute("href", "/admin/purchase-orders/new");
    });

    it("says nothing matches a filter", async () => {
      setLocation("/admin/purchase-orders?status=cancelled");
      suppliers();
      api.get("/admin/purchase-orders", page([]));
      renderUI(<AdminPurchaseOrdersView />);
      expect(await screen.findByText("No purchase orders match")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Raise a purchase order" })).not.toBeInTheDocument();
    });
  });

  it("lists purchase orders with their supplier, status, items, total and dates", async () => {
    signIn("admin", "adm");
    suppliers();
    api.get(
      "/admin/purchase-orders",
      page(
        [
          poListItem(),
          poListItem({ id: "POR002", poNumber: "DCZ-PO-2026-000002", status: "partially-received", statusLabel: "Partially received", total: 562.5, itemCount: 3, expectedAt: null }),
        ],
        { counts: { draft: 1, "partially-received": 1 } },
      ),
    );
    renderUI(<AdminPurchaseOrdersView />);

    expect(await screen.findByRole("link", { name: "DCZ-PO-2026-000001" })).toHaveAttribute("href", "/admin/purchase-orders/detail?id=POR001");
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getByRole("link", { name: "Anvi Textiles" })).toHaveAttribute("href", "/admin/suppliers/detail?id=SUP001");
    expect(rows[1]).toHaveTextContent("Draft");
    expect(rows[1]).toHaveTextContent("₹23,625");
    expect(rows[1]).toHaveTextContent("15 Oct 2026");
    expect(rows[1]).toHaveTextContent("1 Oct 2026");
    expect(rows[2]).toHaveTextContent("Partially received");
    expect(rows[2]).toHaveTextContent("₹562.50");
    expect(rows[2]).toHaveTextContent("—");

    expect(screen.getByRole("tab", { name: "Draft 1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Received 0" })).toBeInTheDocument();
    expect(api.last("GET", "/admin/purchase-orders")!.headers.authorization).toBe("Bearer adm");
  });

  describe("filters", () => {
    it("sends the URL's filters and preselects the supplier for a new PO", async () => {
      setLocation("/admin/purchase-orders?q=PO-1&status=sent&supplier=SUP002&from=2026-09-01&to=2026-09-30&page=2");
      suppliers();
      api.get("/admin/purchase-orders", page([poListItem()], { page: 2, total: 30, totalPages: 2 }));
      renderUI(<AdminPurchaseOrdersView />);
      await screen.findByRole("link", { name: "DCZ-PO-2026-000001" });
      expect(Object.fromEntries(lastQuery().entries())).toEqual({
        q: "PO-1",
        status: "sent",
        supplier: "SUP002",
        from: "2026-09-01",
        to: "2026-09-30",
        page: "2",
        pageSize: "25",
      });
      expect(screen.getByRole("link", { name: /New purchase order/ })).toHaveAttribute("href", "/admin/purchase-orders/new?supplier=SUP002");
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Supplier" })).toHaveValue("SUP002"));
      expect(screen.getByLabelText("Raised from")).toHaveValue("2026-09-01");
    });

    it("lists the suppliers to filter by, keeping one from the URL that isn't in the list", async () => {
      setLocation("/admin/purchase-orders?supplier=SUP999");
      suppliers();
      api.get("/admin/purchase-orders", page([poListItem()]));
      renderUI(<AdminPurchaseOrdersView />);
      await screen.findByRole("link", { name: "DCZ-PO-2026-000001" });
      await waitFor(() =>
        expect(within(screen.getByRole("combobox", { name: "Supplier" })).getAllByRole("option").map((option) => option.textContent)).toEqual([
          "All suppliers",
          "Anvi Textiles",
          "Blue Looms",
          "SUP999",
        ]),
      );
      expect(api.last("GET", "/admin/suppliers")!.query.get("pageSize")).toBe("100");
    });

    it("still works when the supplier list fails", async () => {
      api.get("/admin/suppliers", fail(500));
      api.get("/admin/purchase-orders", page([poListItem()]));
      renderUI(<AdminPurchaseOrdersView />);
      await screen.findByRole("link", { name: "DCZ-PO-2026-000001" });
      expect(within(screen.getByRole("combobox", { name: "Supplier" })).getAllByRole("option")).toHaveLength(1);
    });

    it("changes status, supplier, dates and search through the address bar", async () => {
      setLocation("/admin/purchase-orders");
      suppliers();
      api.get("/admin/purchase-orders", page([poListItem()]));
      const { user, rerender } = renderUI(<AdminPurchaseOrdersView />);
      await screen.findByRole("link", { name: "DCZ-PO-2026-000001" });

      await user.click(screen.getByRole("tab", { name: /^Acknowledged/ }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/purchase-orders?status=acknowledged", { scroll: false });
      rerender(<AdminPurchaseOrdersView />);
      await waitFor(() => expect(lastQuery().get("status")).toBe("acknowledged"));

      await waitFor(() => expect(within(screen.getByRole("combobox", { name: "Supplier" })).getAllByRole("option")).toHaveLength(3));
      await user.selectOptions(screen.getByRole("combobox", { name: "Supplier" }), "SUP002");
      expect(router.replace).toHaveBeenLastCalledWith("/admin/purchase-orders?status=acknowledged&supplier=SUP002", { scroll: false });
      rerender(<AdminPurchaseOrdersView />);

      await user.type(screen.getByLabelText("Raised from"), "2026-09-01");
      expect(router.replace).toHaveBeenLastCalledWith("/admin/purchase-orders?status=acknowledged&supplier=SUP002&from=2026-09-01", { scroll: false });
      rerender(<AdminPurchaseOrdersView />);

      await user.type(screen.getByLabelText("Search purchase orders"), "Q-77");
      await waitFor(() =>
        expect(router.replace).toHaveBeenLastCalledWith("/admin/purchase-orders?q=Q-77&status=acknowledged&supplier=SUP002&from=2026-09-01", { scroll: false }),
      );
    });

    it("clears the filters", async () => {
      setLocation("/admin/purchase-orders?status=sent&to=2026-09-30");
      suppliers();
      api.get("/admin/purchase-orders", page([poListItem()]));
      const { user } = renderUI(<AdminPurchaseOrdersView />);
      await screen.findByRole("link", { name: "DCZ-PO-2026-000001" });
      await user.click(screen.getByRole("button", { name: /Clear filters/ }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/purchase-orders", { scroll: false });
    });

    it("pages through the results and changes the page size", async () => {
      setLocation("/admin/purchase-orders");
      suppliers();
      api.get("/admin/purchase-orders", page([poListItem()], { total: 60, totalPages: 3 }));
      const { user } = renderUI(<AdminPurchaseOrdersView />);
      expect(await screen.findByText("Showing 1–25 of 60")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Next page" }));
      expect(router.replace).toHaveBeenLastCalledWith("/admin/purchase-orders?page=2", { scroll: false });
      await user.selectOptions(screen.getByRole("combobox", { name: /Rows per page/ }), "50");
      expect(router.replace).toHaveBeenLastCalledWith("/admin/purchase-orders?pageSize=50", { scroll: false });
    });
  });
});
