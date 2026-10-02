import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { fresh, siteContent } from "@/test/sliceD-acct1-fixtures";
import { apiItem, apiOrder, signInCustomer, siteContentWithMethods } from "@/test/sliceD-acct2-fixtures";

/**
 * `orderService` caches the delivery/payment method lists at module scope
 * (filled in once by `siteService`'s own page cache) so, like the other
 * account views, each test gets a fresh module registry.
 */
async function load() {
  fresh();
  return (await import("./OrdersView")).OrdersView;
}

describe("OrdersView", () => {
  describe("signed in, loading", () => {
    it("shows placeholders while the orders load", async () => {
      signInCustomer();
      api.get("/site/content", siteContentWithMethods());
      api.get("/orders", () => new Promise(() => undefined));
      const OrdersView = await load();
      const { container } = renderUI(<OrdersView />);
      await waitFor(() => expect(screen.getByRole("heading", { name: "Your orders" })).toBeInTheDocument());
      expect(screen.queryByText("No orders yet")).not.toBeInTheDocument();
      expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    });
  });

  describe("signed in, no orders", () => {
    it("shows the empty state", async () => {
      signInCustomer();
      api.get("/site/content", siteContentWithMethods());
      api.get("/orders", []);
      const OrdersView = await load();
      renderUI(<OrdersView />);
      expect(await screen.findByText("No orders yet")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Start shopping" })).toHaveAttribute("href", "/shop");
    });

    it("shows the empty state when the request fails (getOrders swallows errors)", async () => {
      signInCustomer();
      api.get("/site/content", siteContentWithMethods());
      api.get("/orders", fail(500));
      const OrdersView = await load();
      renderUI(<OrdersView />);
      expect(await screen.findByText("No orders yet")).toBeInTheDocument();
    });
  });

  describe("signed in, with orders", () => {
    it("lists each order with its number, date, item count, total, status and link", async () => {
      signInCustomer();
      api.get("/site/content", siteContentWithMethods());
      api.get("/orders", [apiOrder({ orderNumber: "DCZ-1001", status: "shipped" })]);
      const OrdersView = await load();
      renderUI(<OrdersView />);

      expect(await screen.findByText("DCZ-1001")).toBeInTheDocument();
      expect(screen.getByText(/1 item/)).toBeInTheDocument();
      expect(screen.getByText("Shipped")).toBeInTheDocument();
      const link = screen.getByRole("link", { name: /View details/ });
      expect(link).toHaveAttribute("href", "/account/order?number=DCZ-1001");
    });

    it("uses the plural for more than one item and shows the thumbnails strip", async () => {
      signInCustomer();
      api.get("/site/content", siteContentWithMethods());
      api.get("/orders", [apiOrder({ items: [apiItem({ id: 1 }), apiItem({ id: 2, productId: "P2" })] })]);
      const OrdersView = await load();
      renderUI(<OrdersView />);
      expect(await screen.findByText(/2 items/)).toBeInTheDocument();
    });

    it("shows a '+n more' count beyond five thumbnails", async () => {
      signInCustomer();
      api.get("/site/content", siteContentWithMethods());
      const items = Array.from({ length: 7 }, (_, i) => apiItem({ id: i + 1, productId: `P${i + 1}` }));
      api.get("/orders", [apiOrder({ items })]);
      const OrdersView = await load();
      renderUI(<OrdersView />);
      expect(await screen.findByText("+2 more")).toBeInTheDocument();
    });

    it("says 'Delivered' for a delivered order and 'Arriving ...' otherwise", async () => {
      signInCustomer();
      api.get("/site/content", siteContentWithMethods());
      api.get("/orders", [
        apiOrder({ id: "O1", orderNumber: "DCZ-1", status: "delivered" }),
        apiOrder({ id: "O2", orderNumber: "DCZ-2", status: "shipped", expectedDelivery: "Fri, 25 Sep" }),
      ]);
      const OrdersView = await load();
      renderUI(<OrdersView />);
      // "Delivered" appears twice for that order: the status badge and the footer line.
      expect(await screen.findAllByText("Delivered")).toHaveLength(2);
      expect(screen.getByText("Arriving Fri, 25 Sep")).toBeInTheDocument();
    });

    it("offers 'Order again' for any order except a pending one", async () => {
      signInCustomer();
      api.get("/site/content", siteContentWithMethods());
      api.get("/orders", [
        apiOrder({ id: "O1", orderNumber: "DCZ-1", status: "pending" }),
        apiOrder({ id: "O2", orderNumber: "DCZ-2", status: "confirmed" }),
      ]);
      const OrdersView = await load();
      renderUI(<OrdersView />);
      await screen.findByText("DCZ-1");
      expect(screen.getAllByRole("button", { name: "Order again" })).toHaveLength(1);
    });

    it("opens the reorder dialog for the chosen order and closes it", async () => {
      signInCustomer();
      api.get("/site/content", siteContentWithMethods());
      api.get("/orders", [apiOrder({ id: "O1", orderNumber: "DCZ-1", status: "delivered" })]);
      api.get("/orders/O1/reorder", { orderId: "O1", orderNumber: "DCZ-1", placedAt: "2026-09-20T06:30:00", items: [], addable: 0, unavailable: 0 });
      const OrdersView = await load();
      const { user } = renderUI(<OrdersView />);
      await screen.findByText("DCZ-1");

      await user.click(screen.getByRole("button", { name: "Order again" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByText(/DCZ-1/)).toBeInTheDocument();

      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });

  describe("guest", () => {
    it("is gated behind sign-in", async () => {
      api.get("/site/content", siteContent());
      const OrdersView = await load();
      renderUI(<OrdersView />);
      expect(screen.getByRole("heading", { name: "Your account" })).toBeInTheDocument();
    });
  });
});
