import { describe, expect, it, vi } from "vitest";

import { api, fail } from "@/test/api";
import { setLocation } from "@/test/navigation";
import { renderUI, screen } from "@/test/render";
import { fresh, toastMessages } from "@/test/sliceD-acct1-fixtures";
import { invoice, serveBillingConfig, signInCustomer } from "@/test/sliceD-acct2-fixtures";

// Rendering a PDF (html-to-image / jsPDF under the hood) is heavy and external;
// only that this view *starts* the download at the right moment is this
// component's concern, not how the file itself is produced.
vi.mock("@/lib/billing/invoicePdf", () => ({ downloadInvoicePdf: vi.fn().mockResolvedValue(undefined) }));

async function load() {
  fresh();
  return (await import("./InvoiceDetailView")).InvoiceDetailView;
}

describe("InvoiceDetailView", () => {
  describe("loading", () => {
    it("shows a skeleton while the invoice or the billing config loads", async () => {
      setLocation("/account/invoice?id=INV1");
      signInCustomer();
      serveBillingConfig();
      api.get("/invoices/INV1", () => new Promise(() => undefined));
      const InvoiceDetailView = await load();
      renderUI(<InvoiceDetailView />);
      expect(screen.getByRole("heading", { name: "Invoice" })).toBeInTheDocument();
      expect(screen.queryByText(/DCZ-INV/)).not.toBeInTheDocument();
    });
  });

  describe("no id", () => {
    it("treats a missing id as not found, without calling the server", async () => {
      setLocation("/account/invoice");
      signInCustomer();
      serveBillingConfig();
      const InvoiceDetailView = await load();
      renderUI(<InvoiceDetailView />);
      expect(await screen.findByText("We could not find that invoice")).toBeInTheDocument();
      expect(api.requests("GET", /^\/invoices/)).toHaveLength(0);
    });
  });

  describe("not found", () => {
    it("offers a way back to the invoice list", async () => {
      setLocation("/account/invoice?id=MISSING");
      signInCustomer();
      serveBillingConfig();
      api.get("/invoices/MISSING", fail(404, "Not found"));
      const InvoiceDetailView = await load();
      renderUI(<InvoiceDetailView />);
      expect(await screen.findByText("We could not find that invoice")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Your invoices" })).toHaveAttribute("href", "/account/invoices");
    });
  });

  describe("found", () => {
    it("shows the title, order, breadcrumb and the document", async () => {
      setLocation("/account/invoice?id=INV1");
      signInCustomer();
      serveBillingConfig();
      api.get("/invoices/INV1", invoice({ id: "INV1", invoiceNumber: "DCZ-INV-1", orderNumber: "DCZ-1001" }));
      const InvoiceDetailView = await load();
      renderUI(<InvoiceDetailView />);

      expect(await screen.findByRole("heading", { name: "DCZ-INV-1" })).toBeInTheDocument();
      expect(screen.getByText("Order DCZ-1001")).toBeInTheDocument();
      const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
      expect(crumbs).toHaveTextContent("Invoices");
      expect(screen.getByRole("link", { name: "Invoices" })).toHaveAttribute("href", "/account/invoices");
      expect(screen.getByRole("button", { name: "Print invoice" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    });
  });

  describe("?download=pdf", () => {
    it("starts the PDF download automatically once the document and config are ready, and toasts on success", async () => {
      vi.useFakeTimers();
      setLocation("/account/invoice?id=INV1&download=pdf");
      signInCustomer();
      serveBillingConfig();
      api.get("/invoices/INV1", invoice({ id: "INV1", invoiceNumber: "DCZ-INV-1" }));
      const InvoiceDetailView = await load();
      renderUI(<InvoiceDetailView />);
      await vi.waitFor(() => expect(screen.queryByRole("heading", { name: "DCZ-INV-1" })).toBeInTheDocument());

      await vi.advanceTimersByTimeAsync(400);
      expect(await toastMessages()).toContain("success: DCZ-INV-1 downloaded");
      vi.useRealTimers();
    });

    it("does not start the download twice across re-renders", async () => {
      vi.useFakeTimers();
      setLocation("/account/invoice?id=INV1&download=pdf");
      signInCustomer();
      serveBillingConfig();
      api.get("/invoices/INV1", invoice({ id: "INV1", invoiceNumber: "DCZ-INV-1" }));
      const InvoiceDetailView = await load();
      const { rerender } = renderUI(<InvoiceDetailView />);
      await vi.waitFor(() => expect(screen.queryByRole("heading", { name: "DCZ-INV-1" })).toBeInTheDocument());
      await vi.advanceTimersByTimeAsync(400);
      rerender(<InvoiceDetailView />);
      await vi.advanceTimersByTimeAsync(400);
      const messages = await toastMessages();
      expect(messages.filter((m) => m === "success: DCZ-INV-1 downloaded")).toHaveLength(1);
      vi.useRealTimers();
    });
  });
});
