import { describe, expect, it } from "vitest";

import type { AlertProduct, PriceAlert, StockAlert } from "@/services/engagementService";
import { api, fail, networkError } from "@/test/api";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { signInCustomer } from "@/test/sliceD-acct3-session";
import { useToastStore } from "@/store/toastStore";

import { AccountAlertsView } from "./AccountAlertsView";

function product(overrides: Partial<AlertProduct> = {}): AlertProduct {
  return {
    id: "P1",
    slug: "linen-shirt",
    name: "Linen Shirt",
    brand: "DCZ",
    image: "/img/shirt.jpg",
    price: 1299,
    originalPrice: 1599,
    available: false,
    listed: true,
    ...overrides,
  };
}

function stockAlert(overrides: Partial<StockAlert> = {}): StockAlert {
  return {
    id: 1,
    kind: "stock",
    status: "active",
    size: "M",
    color: "Blue",
    createdAt: "2026-03-05",
    notifiedAt: null,
    product: product(),
    ...overrides,
  };
}

function priceAlert(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: 7,
    kind: "price",
    status: "active",
    mode: "any",
    baselinePrice: 2000,
    targetPrice: null,
    notifiedPrice: null,
    createdAt: "2026-04-10",
    notifiedAt: null,
    product: product({ id: "P2", name: "Wool Scarf", price: 1800, available: true }),
    ...overrides,
  };
}

function toasts() {
  return useToastStore.getState().toasts.map((t) => ({ message: t.message, tone: t.tone }));
}

function setup(alerts: { stock: StockAlert[]; price: PriceAlert[] } = { stock: [], price: [] }) {
  signInCustomer();
  api.get("/alerts", alerts);
  return renderUI(<AccountAlertsView />);
}

describe("AccountAlertsView", () => {
  describe("access", () => {
    it("asks a signed-out visitor to sign in and never loads alerts", async () => {
      renderUI(<AccountAlertsView />);
      expect(await screen.findByRole("heading", { name: "Your account" })).toBeInTheDocument();
      expect(api.requests("GET", "/alerts")).toHaveLength(0);
    });

    it("loads the alerts with the customer's token once signed in", async () => {
      setup({ stock: [stockAlert()], price: [] });
      expect(await screen.findByRole("link", { name: "Linen Shirt" })).toBeInTheDocument();
      expect(api.last("GET", "/alerts")!.headers.authorization).toBe("Bearer cust-token");
    });
  });

  describe("loading, empty and error states", () => {
    it("shows the page title and placeholders while the alerts load", () => {
      signInCustomer();
      api.get("/alerts", () => new Promise(() => undefined));
      const { container } = renderUI(<AccountAlertsView />);
      expect(screen.getByRole("heading", { name: "Stock & price alerts" })).toBeInTheDocument();
      expect(container.querySelectorAll(".h-24")).toHaveLength(3);
    });

    it("explains how to set alerts up when there are none", async () => {
      setup();
      expect(await screen.findByRole("heading", { name: "No alerts yet" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Browse products" })).toHaveAttribute("href", "/shop");
    });

    it.each([
      ["a server error", fail(500)],
      ["an expired session", fail(401, "Sign in again", "UNAUTHORIZED")],
      ["a network failure", networkError()],
    ])("shows an error with a retry after %s, and recovers on retry", async (_label, reply) => {
      signInCustomer();
      api.get("/alerts", { stock: [stockAlert()], price: [] });
      api.once("GET", "/alerts", reply);
      const { user } = renderUI(<AccountAlertsView />);
      expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
      await user.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("link", { name: "Linen Shirt" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(api.requests("GET", "/alerts")).toHaveLength(2);
    });
  });

  describe("back-in-stock alerts", () => {
    it("lists the product, its variant, its live price and availability, and the date it was set", async () => {
      setup({ stock: [stockAlert()], price: [] });
      const item = (await screen.findByRole("link", { name: "Linen Shirt" })).closest("li")!;
      expect(screen.getByRole("heading", { name: "Back in stock" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Price drops" })).not.toBeInTheDocument();
      expect(within(item).getByRole("link", { name: "Linen Shirt" })).toHaveAttribute("href", "/product/P1");
      expect(within(item).getByText("M · Blue")).toBeInTheDocument();
      expect(within(item).getByText("Now ₹1,299 · Sold out")).toBeInTheDocument();
      expect(within(item).getByText("Since 5 Mar 2026")).toBeInTheDocument();
      expect(within(item).getByText("Watching")).toBeInTheDocument();
      expect(within(item).getByRole("button", { name: "Stop alert" })).toBeEnabled();
    });

    it.each([
      [{ size: "", color: "" }, "Any size or colour"],
      [{ size: "L", color: "" }, "L"],
      [{ size: "", color: "Red" }, "Red"],
    ])("describes variant %o as %s", async (variant, text) => {
      setup({ stock: [stockAlert(variant)], price: [] });
      expect(await screen.findByText(text)).toBeInTheDocument();
    });

    it.each([
      [{ available: true, listed: true }, "In stock"],
      [{ available: false, listed: true }, "Sold out"],
      [{ available: false, listed: false }, "Not available"],
    ])("reports availability %o as %s", async (state, label) => {
      setup({ stock: [stockAlert({ product: product(state) })], price: [] });
      expect(await screen.findByText(`Now ₹1,299 · ${label}`)).toBeInTheDocument();
    });

    it("shows an emailed alert with its date, and without a stop button", async () => {
      setup({ stock: [stockAlert({ status: "notified", notifiedAt: "2026-06-02" })], price: [] });
      expect(await screen.findByText("Emailed 2 Jun 2026")).toBeInTheDocument();
      expect(screen.getByText("Emailed")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop alert" })).not.toBeInTheDocument();
    });

    it("labels a stopped alert", async () => {
      setup({ stock: [stockAlert({ status: "unsubscribed" })], price: [] });
      expect(await screen.findByText("Stopped")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop alert" })).not.toBeInTheDocument();
    });

    it("falls back to the Watching label for a status it does not know", async () => {
      setup({ stock: [stockAlert({ status: "mystery" as StockAlert["status"] })], price: [] });
      expect(await screen.findByText("Watching")).toBeInTheDocument();
      // Only active alerts can be stopped.
      expect(screen.queryByRole("button", { name: "Stop alert" })).not.toBeInTheDocument();
    });

    it("keeps an alert whose product was removed, without a link or price", async () => {
      setup({ stock: [stockAlert({ product: null })], price: [] });
      expect(await screen.findByText("No longer available")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Linen Shirt" })).not.toBeInTheDocument();
      expect(screen.queryByText(/^Now /)).not.toBeInTheDocument();
    });
  });

  describe("price-drop alerts", () => {
    it("describes an any-drop alert by its baseline price", async () => {
      setup({ stock: [], price: [priceAlert()] });
      expect(await screen.findByRole("heading", { name: "Price drops" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Back in stock" })).not.toBeInTheDocument();
      expect(screen.getByText("Any drop below ₹2,000")).toBeInTheDocument();
      expect(screen.getByText("Now ₹1,800 · In stock")).toBeInTheDocument();
      expect(screen.getByText("Since 10 Apr 2026")).toBeInTheDocument();
    });

    it("describes a target alert by its target price", async () => {
      setup({ stock: [], price: [priceAlert({ mode: "target", targetPrice: 1500 })] });
      expect(await screen.findByText("When it reaches ₹1,500")).toBeInTheDocument();
    });

    it("treats a target alert with no target price as any drop", async () => {
      setup({ stock: [], price: [priceAlert({ mode: "target", targetPrice: null })] });
      expect(await screen.findByText("Any drop below ₹2,000")).toBeInTheDocument();
    });

    it("says when and at what price an alert was emailed", async () => {
      setup({ stock: [], price: [priceAlert({ status: "notified", notifiedAt: "2026-07-01", notifiedPrice: 1499 })] });
      expect(await screen.findByText("Emailed 1 Jul 2026 at ₹1,499")).toBeInTheDocument();
    });

    it("leaves out the price when an emailed alert has none recorded", async () => {
      setup({ stock: [], price: [priceAlert({ status: "notified", notifiedAt: "2026-07-01", notifiedPrice: null })] });
      expect(await screen.findByText("Emailed 1 Jul 2026")).toBeInTheDocument();
    });
  });

  describe("stopping an alert", () => {
    it("DELETEs the alert, confirms it, and reloads the list", async () => {
      const { user } = setup({ stock: [stockAlert()], price: [priceAlert()] });
      api.delete("/alerts/price/7", priceAlert({ status: "unsubscribed" }));
      const scarf = (await screen.findByRole("link", { name: "Wool Scarf" })).closest("li")!;
      api.get("/alerts", { stock: [stockAlert()], price: [priceAlert({ status: "unsubscribed" })] });

      await user.click(within(scarf).getByRole("button", { name: "Stop alert" }));

      await waitFor(() => expect(within(scarf).getByText("Stopped")).toBeInTheDocument());
      const request = api.last("DELETE", "/alerts/price/7")!;
      expect(request.headers.authorization).toBe("Bearer cust-token");
      expect(toasts()).toEqual([{ message: "Alert stopped.", tone: "info" }]);
      expect(api.requests("GET", "/alerts")).toHaveLength(2);
      // The other alert is untouched.
      const shirt = screen.getByRole("link", { name: "Linen Shirt" }).closest("li")!;
      expect(within(shirt).getByRole("button", { name: "Stop alert" })).toBeEnabled();
    });

    it("disables only the alert being stopped and shows Stopping…", async () => {
      const { user } = setup({ stock: [stockAlert(), stockAlert({ id: 2, product: product({ id: "P9", name: "Cap" }) })], price: [] });
      api.delete("/alerts/stock/1", () => new Promise(() => undefined));
      const shirt = (await screen.findByRole("link", { name: "Linen Shirt" })).closest("li")!;
      const cap = screen.getByRole("link", { name: "Cap" }).closest("li")!;

      await user.click(within(shirt).getByRole("button", { name: "Stop alert" }));

      expect(within(shirt).getByRole("button", { name: "Stopping…" })).toBeDisabled();
      expect(within(cap).getByRole("button", { name: "Stop alert" })).toBeEnabled();
    });

    it("shows the server's reason when stopping fails, and re-enables the button", async () => {
      const { user } = setup({ stock: [stockAlert()], price: [] });
      api.delete("/alerts/stock/1", fail(404, "That alert no longer exists.", "NOT_FOUND"));
      await user.click(await screen.findByRole("button", { name: "Stop alert" }));
      await waitFor(() => expect(toasts()).toEqual([{ message: "That alert no longer exists.", tone: "error" }]));
      expect(screen.getByRole("button", { name: "Stop alert" })).toBeEnabled();
      expect(api.requests("GET", "/alerts")).toHaveLength(1);
    });

    it("shows a generic message when the network fails", async () => {
      const { user } = setup({ stock: [stockAlert()], price: [] });
      api.delete("/alerts/stock/1", networkError());
      await user.click(await screen.findByRole("button", { name: "Stop alert" }));
      await waitFor(() => expect(toasts()).toHaveLength(1));
      // The client wraps network failures in its own ApiError, so its message is shown.
      expect(toasts()[0]!.tone).toBe("error");
      expect(toasts()[0]!.message).not.toBe("");
    });

    it("shows the empty state once the last alert is stopped", async () => {
      const { user } = setup({ stock: [stockAlert()], price: [] });
      api.delete("/alerts/stock/1", stockAlert({ status: "unsubscribed" }));
      await screen.findByRole("link", { name: "Linen Shirt" });
      api.get("/alerts", { stock: [], price: [] });
      await user.click(screen.getByRole("button", { name: "Stop alert" }));
      expect(await screen.findByRole("heading", { name: "No alerts yet" })).toBeInTheDocument();
    });
  });
});
