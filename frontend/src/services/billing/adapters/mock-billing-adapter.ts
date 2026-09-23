import creditNotesJson from "@/data/billing/credit-notes.json";
import invoicesJson from "@/data/billing/invoices.json";
import paymentsJson from "@/data/billing/payments.json";
import refundsJson from "@/data/billing/refunds.json";

import type {
  BillingStats,
  CreditNote,
  Invoice,
  Payment,
  Refund,
  TaxReportRow,
} from "@/types";

import { OVERLAY_KEYS, create, remove, resolve, update } from "@/lib/admin/mock-store";
import { sum } from "@/lib/money";

import type {
  BillingDataSource,
  InvoiceQuery,
  PaymentQuery,
  RefundQuery,
} from "../billing-data-source";

/**
 * Billing over local JSON.
 *
 * The same overlay arrangement the rest of the portal uses: the committed JSON
 * is the base, local storage holds what has been created, edited or deleted
 * since, and reads resolve the two. An invoice raised at checkout and an
 * invoice that shipped with the demo are then indistinguishable to every
 * caller, which is the point.
 *
 * Nothing is cached. An admin who marks an invoice paid must see it paid, and a
 * stale list is a worse failure than resolving 164 records again.
 */

const BASE_INVOICES = invoicesJson as unknown as Invoice[];
const BASE_PAYMENTS = paymentsJson as unknown as Payment[];
const BASE_REFUNDS = refundsJson as unknown as Refund[];
const BASE_CREDIT_NOTES = creditNotesJson as unknown as CreditNote[];

const allInvoices = () => resolve(BASE_INVOICES, OVERLAY_KEYS.invoices);
const allPayments = () => resolve(BASE_PAYMENTS, OVERLAY_KEYS.payments);
const allRefunds = () => resolve(BASE_REFUNDS, OVERLAY_KEYS.refunds);
const allCreditNotes = () => resolve(BASE_CREDIT_NOTES, OVERLAY_KEYS.creditNotes);

/** Simulated latency, matching the other adapters. Zero unless configured. */
const LATENCY = Number(process.env.NEXT_PUBLIC_MOCK_LATENCY ?? 0);

function settle<T>(value: T): Promise<T> {
  if (LATENCY <= 0) return Promise.resolve(value);
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY));
}

/** Every term must appear somewhere in the row. */
function matchesSearch(haystack: string, search: string | undefined): boolean {
  if (!search?.trim()) return true;
  const hay = haystack.toLowerCase();
  return search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .every((term) => hay.includes(term));
}

function withinWindow(at: string, from?: string, to?: string): boolean {
  const t = new Date(at).getTime();
  if (from && t < new Date(from).getTime()) return false;
  // `to` is an inclusive day, so compare against its end.
  if (to && t > new Date(to).getTime() + 86399999) return false;
  return true;
}

export const mockBillingAdapter: BillingDataSource = {
  async listInvoices(query: InvoiceQuery = {}) {
    const rows = allInvoices().filter((invoice) => {
      if (query.status && query.status !== "all" && invoice.status !== query.status) return false;
      if (query.paymentStatus && query.paymentStatus !== "all" && invoice.paymentStatus !== query.paymentStatus) return false;
      if (query.customerId && invoice.customerId !== query.customerId) return false;
      if (query.orderId && invoice.orderId !== query.orderId) return false;
      if (!withinWindow(invoice.issuedAt, query.from, query.to)) return false;
      if (query.minAmount !== undefined && invoice.breakdown.grandTotal < query.minAmount) return false;
      if (query.maxAmount !== undefined && invoice.breakdown.grandTotal > query.maxAmount) return false;

      return matchesSearch(
        [invoice.invoiceNumber, invoice.orderNumber, invoice.customerName, invoice.customerEmail].join(" "),
        query.search,
      );
    });

    // Newest first: an invoice list is read from the top.
    return settle(rows.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)));
  },

  async getInvoice(id) {
    return settle(allInvoices().find((invoice) => invoice.id === id) ?? null);
  },

  async getInvoiceByOrderId(orderId) {
    return settle(allInvoices().find((invoice) => invoice.orderId === orderId) ?? null);
  },

  async createInvoice(invoice) {
    create(OVERLAY_KEYS.invoices, invoice);
    return settle(invoice);
  },

  async updateInvoice(invoice) {
    update(OVERLAY_KEYS.invoices, invoice);
    return settle(invoice);
  },

  async listPayments(query: PaymentQuery = {}) {
    const rows = allPayments().filter((payment) => {
      if (query.status && query.status !== "all" && payment.status !== query.status) return false;
      if (query.method && query.method !== "all" && payment.method !== query.method) return false;
      if (query.customerId && payment.customerId !== query.customerId) return false;
      if (query.orderId && payment.orderId !== query.orderId) return false;
      if (!withinWindow(payment.createdAt, query.from, query.to)) return false;

      return matchesSearch(
        [payment.transactionId, payment.orderNumber, payment.invoiceNumber, payment.customerName, payment.customerEmail].join(" "),
        query.search,
      );
    });

    return settle(rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  },

  async getPayment(id) {
    return settle(allPayments().find((payment) => payment.id === id) ?? null);
  },

  async getPaymentByOrderId(orderId) {
    return settle(allPayments().find((payment) => payment.orderId === orderId) ?? null);
  },

  async createPayment(payment) {
    create(OVERLAY_KEYS.payments, payment);
    return settle(payment);
  },

  async updatePayment(payment) {
    update(OVERLAY_KEYS.payments, payment);
    return settle(payment);
  },

  async listRefunds(query: RefundQuery = {}) {
    const rows = allRefunds().filter((refund) => {
      if (query.status && query.status !== "all" && refund.status !== query.status) return false;
      if (query.orderId && refund.orderId !== query.orderId) return false;
      if (query.customerId && refund.customerId !== query.customerId) return false;

      return matchesSearch(
        [refund.refundNumber, refund.orderNumber, refund.invoiceNumber, refund.customerName, refund.reason].join(" "),
        query.search,
      );
    });

    return settle(rows.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)));
  },

  async getRefund(id) {
    return settle(allRefunds().find((refund) => refund.id === id) ?? null);
  },

  async createRefund(refund) {
    create(OVERLAY_KEYS.refunds, refund);
    return settle(refund);
  },

  async updateRefund(refund) {
    update(OVERLAY_KEYS.refunds, refund);
    return settle(refund);
  },

  async listCreditNotes() {
    return settle(
      allCreditNotes().sort((a, b) => b.issuedAt.localeCompare(a.issuedAt)),
    );
  },

  async getCreditNote(id) {
    return settle(allCreditNotes().find((note) => note.id === id) ?? null);
  },

  async createCreditNote(note) {
    create(OVERLAY_KEYS.creditNotes, note);
    return settle(note);
  },

  async updateCreditNote(note) {
    update(OVERLAY_KEYS.creditNotes, note);
    return settle(note);
  },

  /**
   * The dashboard's figures, recomputed from the records every time.
   *
   * Never read from a stored total. Marking an invoice paid or completing a
   * refund has to move these numbers immediately, and a cached aggregate is
   * exactly how a dashboard starts lying about a business.
   */
  async getStats(from, to) {
    const invoices = allInvoices().filter(
      (invoice) => invoice.status !== "cancelled" && withinWindow(invoice.issuedAt, from, to),
    );
    const payments = allPayments().filter((payment) => withinWindow(payment.createdAt, from, to));
    const refunds = allRefunds().filter((refund) => withinWindow(refund.requestedAt, from, to));
    const creditNotes = allCreditNotes().filter((note) => withinWindow(note.issuedAt, from, to));

    const revenue = sum(invoices.map((invoice) => invoice.breakdown.grandTotal));
    const paid = sum(invoices.map((invoice) => invoice.amountPaid));
    const refunded = sum(
      refunds.filter((refund) => refund.status === "completed").map((refund) => refund.amount),
    );

    return settle<BillingStats>({
      revenue,
      paid,
      // What has been invoiced but not settled — the collectable balance.
      pending: Math.max(0, revenue - paid),
      refunded,
      taxCollected: sum(invoices.map((invoice) => invoice.breakdown.tax.totalTax)),
      shippingRevenue: sum(invoices.map((invoice) => invoice.breakdown.shipping)),
      discountsGiven: sum(invoices.map((invoice) => invoice.breakdown.couponDiscount)),
      invoiceCount: invoices.length,
      paymentCount: payments.length,
      refundCount: refunds.length,
      creditNoteCount: creditNotes.length,
      netSales: paid - refunded,
    });
  },

  /**
   * Tax collected, grouped by the rate that produced it.
   *
   * Grouped by rate rather than by category because that is how a return is
   * filed — the question is "how much was collected at 5%", not "how much came
   * from footwear".
   */
  async getTaxReport(from, to) {
    const invoices = allInvoices().filter(
      (invoice) => invoice.status !== "cancelled" && withinWindow(invoice.issuedAt, from, to),
    );

    const byRate = new Map<number, TaxReportRow>();
    const invoicesAtRate = new Map<number, Set<string>>();

    for (const invoice of invoices) {
      for (const line of invoice.lines) {
        const rate = line.taxRatePercent;
        const row = byRate.get(rate) ?? {
          ratePercent: rate,
          taxableAmount: 0,
          cgst: 0,
          sgst: 0,
          igst: 0,
          totalTax: 0,
          invoiceCount: 0,
        };

        row.taxableAmount += line.taxableAmount;
        row.cgst += line.cgst;
        row.sgst += line.sgst;
        row.igst += line.igst;
        row.totalTax += line.tax;
        byRate.set(rate, row);

        const seen = invoicesAtRate.get(rate) ?? new Set<string>();
        seen.add(invoice.id);
        invoicesAtRate.set(rate, seen);
      }
    }

    for (const [rate, row] of byRate) {
      row.invoiceCount = invoicesAtRate.get(rate)?.size ?? 0;
    }

    return settle(
      [...byRate.values()].sort((a, b) => a.ratePercent - b.ratePercent),
    );
  },
};

/** Exposed for the refund flow, which removes a draft credit note. */
export { remove as removeBillingRecord };
