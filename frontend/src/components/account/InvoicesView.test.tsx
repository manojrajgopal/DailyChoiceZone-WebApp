import { describe, expect, it, vi } from "vitest";

import { api, fail } from "@/test/api";
import { router } from "@/test/navigation";
import { renderUI, screen, waitFor, within } from "@/test/render";
import { fresh } from "@/test/sliceD-acct1-fixtures";
import { invoice, serveBillingConfig } from "@/test/sliceD-acct2-fixtures";

/**
 * `useBillingConfig`/`useTaxConfig` read through `billingService`/`taxService`,
 * both backed by the page-lifetime cache in `services/api/cache.ts` (see the
 * cart/checkout tests for the same issue with payment methods) — fresh module
 * registry per test, view imported dynamically afterwards.
 */
async function load() {
  fresh();
  return (await import("./InvoicesView")).InvoicesView;
}

describe("InvoicesView", () => {
  describe("loading", () => {
    it("shows placeholders while invoices load", async () => {
      serveBillingConfig();
      api.get("/invoices", () => new Promise(() => undefined));
      const InvoicesView = await load();
      const { container } = renderUI(<InvoicesView />);
      expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
      expect(screen.queryByText("No invoices yet")).not.toBeInTheDocument();
    });
  });

  describe("empty", () => {
    it("shows the empty state", async () => {
      serveBillingConfig();
      api.get("/invoices", []);
      const InvoicesView = await load();
      renderUI(<InvoicesView />);
      expect(await screen.findByText("No invoices yet")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Start shopping" })).toHaveAttribute("href", "/shop");
    });

    it("shows the empty state when the request fails", async () => {
      serveBillingConfig();
      api.get("/invoices", fail(500));
      const InvoicesView = await load();
      renderUI(<InvoicesView />);
      expect(await screen.findByText("No invoices yet")).toBeInTheDocument();
    });
  });

  describe("with invoices", () => {
    it("lists each invoice with its number, order link, date, total, status and item count", async () => {
      serveBillingConfig();
      api.get("/invoices", [invoice({ id: "INV1", invoiceNumber: "DCZ-INV-1", orderNumber: "DCZ-1001" })]);
      const InvoicesView = await load();
      renderUI(<InvoicesView />);

      const numberLink = await screen.findByRole("link", { name: "DCZ-INV-1" });
      expect(numberLink).toHaveAttribute("href", "/account/invoice?id=INV1");
      expect(screen.getByRole("link", { name: "DCZ-1001" })).toHaveAttribute("href", "/account/order?number=DCZ-1001");
      expect(screen.getByRole("link", { name: "View invoice" })).toHaveAttribute("href", "/account/invoice?id=INV1");
      expect(screen.getByText("₹1,499")).toBeInTheDocument();
      expect(screen.getByText("1 item")).toBeInTheDocument();
      expect(screen.getByText("Paid")).toBeInTheDocument();
    });

    it("uses the plural for more than one item", async () => {
      serveBillingConfig();
      api.get("/invoices", [invoice({ breakdown: { ...invoice().breakdown, itemCount: 3 } })]);
      const InvoicesView = await load();
      renderUI(<InvoicesView />);
      expect(await screen.findByText("3 items")).toBeInTheDocument();
    });

    it("sends the PDF download straight to the invoice page (no document on this page to render)", async () => {
      serveBillingConfig();
      api.get("/invoices", [invoice({ id: "INV1" })]);
      const InvoicesView = await load();
      const { user } = renderUI(<InvoicesView />);
      await user.click(await screen.findByRole("button", { name: "Download" }));
      const menu = screen.getByRole("menu", { name: "Download format" });
      expect(within(menu).getByText("PDF")).toBeInTheDocument();
      expect(within(menu).getByText("Excel (.xlsx)")).toBeInTheDocument();
      expect(within(menu).getByText("CSV")).toBeInTheDocument();

      await user.click(within(menu).getByRole("menuitem", { name: /PDF/ }));
      expect(router.push).toHaveBeenCalledWith("/account/invoice?id=INV1&download=pdf");
    });

    it("downloads a CSV directly from the list", async () => {
      serveBillingConfig();
      api.get("/invoices", [invoice({ invoiceNumber: "DCZ-INV-1" })]);
      const InvoicesView = await load();
      const { user } = renderUI(<InvoicesView />);
      await user.click(await screen.findByRole("button", { name: "Download" }));
      const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:csv");
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

      await user.click(screen.getByRole("menuitem", { name: /CSV/ }));
      await waitFor(() => expect(create).toHaveBeenCalled());
    });
  });
});
