import type {
  BillingStats,
  CreditNote,
  Invoice,
  Payment,
  Refund,
  TaxReportRow,
} from "@/types";

import { apiGet, apiPost, apiPut, query } from "@/services/api/client";

import type {
  BillingDataSource,
  CreditNoteDraft,
  InvoiceQuery,
  PaymentQuery,
  RefundDraft,
  RefundQuery,
} from "../billing-data-source";

/**
 * Billing, over the REST API.
 *
 * The same `BillingDataSource` the mock implemented. Everything above it — the
 * invoice document, the portal's billing pages, the reports — is unchanged.
 *
 * There is no way to create an invoice or a payment here, which is the
 * contract rather than an omission: both are produced by placing an order,
 * inside the transaction that also takes the stock and records the coupon.
 */

const AUTH = { auth: "admin" } as const;
const CUSTOMER = { auth: "customer" } as const;

export const httpBillingAdapter: BillingDataSource = {
  listInvoices(invoiceQuery: InvoiceQuery = {}): Promise<Invoice[]> {
    return apiGet<Invoice[]>(
      `/admin/billing/invoices${query({
        search: invoiceQuery.search,
        status: invoiceQuery.status,
        paymentStatus: invoiceQuery.paymentStatus,
        from: invoiceQuery.from,
        to: invoiceQuery.to,
        minAmount: invoiceQuery.minAmount,
      })}`,
      AUTH,
    );
  },

  getInvoice(id: string): Promise<Invoice | null> {
    return apiGet<Invoice>(`/admin/billing/invoices/${encodeURIComponent(id)}`, AUTH).catch(
      () => null,
    );
  },

  async getInvoiceByOrderId(orderId: string): Promise<Invoice | null> {
    // Invoices are one per order, so this is a filter rather than a route of
    // its own — one way to read an invoice, narrowed.
    const invoices = await apiGet<Invoice[]>("/admin/billing/invoices", AUTH);
    return invoices.find((invoice) => invoice.orderId === orderId) ?? null;
  },

  listMyInvoices(): Promise<Invoice[]> {
    return apiGet<Invoice[]>("/invoices", CUSTOMER);
  },

  getMyInvoice(id: string): Promise<Invoice | null> {
    return apiGet<Invoice>(`/invoices/${encodeURIComponent(id)}`, CUSTOMER).catch(() => null);
  },

  async updateInvoice(invoice: Invoice): Promise<Invoice> {
    // The one edit the portal makes is recording a settlement.
    return apiPost<Invoice>(
      `/admin/billing/invoices/${encodeURIComponent(invoice.id)}/mark-paid`,
      { amount: invoice.amountPaid },
      AUTH,
    );
  },

  listPayments(paymentQuery: PaymentQuery = {}): Promise<Payment[]> {
    return apiGet<Payment[]>(
      `/admin/billing/payments${query({
        search: paymentQuery.search,
        status: paymentQuery.status,
        method: paymentQuery.method,
      })}`,
      AUTH,
    );
  },

  getPayment(id: string): Promise<Payment | null> {
    return apiGet<Payment>(`/admin/billing/payments/${encodeURIComponent(id)}`, AUTH).catch(
      () => null,
    );
  },

  async getPaymentByOrderId(orderId: string): Promise<Payment | null> {
    const payments = await apiGet<Payment[]>("/admin/billing/payments", AUTH);
    return payments.find((payment) => payment.orderId === orderId) ?? null;
  },

  updatePayment(payment: Payment): Promise<Payment> {
    return apiPost<Payment>(
      `/admin/billing/payments/${encodeURIComponent(payment.id)}/capture`,
      {},
      AUTH,
    );
  },

  listRefunds(refundQuery: RefundQuery = {}): Promise<Refund[]> {
    return apiGet<Refund[]>(
      `/admin/billing/refunds${query({
        search: refundQuery.search,
        status: refundQuery.status,
        orderId: refundQuery.orderId,
      })}`,
      AUTH,
    );
  },

  async getRefund(id: string): Promise<Refund | null> {
    const refunds = await apiGet<Refund[]>("/admin/billing/refunds", AUTH);
    return refunds.find((refund) => refund.id === id) ?? null;
  },

  createRefund(draft: RefundDraft): Promise<Refund> {
    return apiPost<Refund>(
      "/admin/billing/refunds",
      {
        invoiceId: draft.invoiceId,
        amount: draft.amount,
        reason: draft.reason,
        lines: draft.lines ?? [],
        status: draft.status ?? "completed",
      },
      AUTH,
    );
  },

  updateRefund(refund: Refund): Promise<Refund> {
    return apiPut<Refund>(
      `/admin/billing/refunds/${encodeURIComponent(refund.id)}`,
      { status: refund.status },
      AUTH,
    );
  },

  listCreditNotes(): Promise<CreditNote[]> {
    return apiGet<CreditNote[]>("/admin/billing/credit-notes", AUTH);
  },

  async getCreditNote(id: string): Promise<CreditNote | null> {
    const notes = await apiGet<CreditNote[]>("/admin/billing/credit-notes", AUTH);
    return notes.find((note) => note.id === id) ?? null;
  },

  createCreditNote(draft: CreditNoteDraft): Promise<CreditNote> {
    return apiPost<CreditNote>(
      "/admin/billing/credit-notes",
      {
        invoiceId: draft.invoiceId,
        total: draft.total,
        reason: draft.reason,
        refundId: draft.refundId ?? null,
        status: draft.status ?? "issued",
      },
      AUTH,
    );
  },

  updateCreditNote(note: CreditNote): Promise<CreditNote> {
    return apiPut<CreditNote>(
      `/admin/billing/credit-notes/${encodeURIComponent(note.id)}`,
      { status: note.status },
      AUTH,
    );
  },

  getStats(from?: string, to?: string): Promise<BillingStats> {
    return apiGet<BillingStats>(`/admin/billing/stats${query({ from, to })}`, AUTH);
  },

  getTaxReport(from?: string, to?: string): Promise<TaxReportRow[]> {
    return apiGet<TaxReportRow[]>(`/admin/billing/tax-report${query({ from, to })}`, AUTH);
  },
};
