import type {
  BillingStats,
  CreditNote,
  CreditNoteStatus,
  Invoice,
  Money,
  Payment,
  Refund,
  RefundLine,
  RefundStatus,
  TaxReportRow,
} from "@/types";

/**
 * Where billing records come from.
 *
 * The same arrangement as `DataSource` and `AdminDataSource`: one contract,
 * one adapter over the REST API. Every method is named for the endpoint behind
 * it, so the mapping is not something anyone has to infer:
 *
 *   listInvoices      → GET    /admin/billing/invoices
 *   getInvoice        → GET    /admin/billing/invoices/:id
 *   updateInvoice     → POST   /admin/billing/invoices/:id/mark-paid
 *
 *   listMyInvoices    → GET    /invoices              — a customer's own
 *   getMyInvoice      → GET    /invoices/:id
 *
 *   listPayments      → GET    /admin/billing/payments
 *   getPayment        → GET    /admin/billing/payments/:id
 *   updatePayment     → POST   /admin/billing/payments/:id/capture
 *
 *   listRefunds       → GET    /admin/billing/refunds
 *   createRefund      → POST   /admin/billing/refunds
 *   updateRefund      → PUT    /admin/billing/refunds/:id
 *
 *   listCreditNotes   → GET    /admin/billing/credit-notes
 *   createCreditNote  → POST   /admin/billing/credit-notes
 *   updateCreditNote  → PUT    /admin/billing/credit-notes/:id
 *
 *   getStats          → GET    /admin/billing/stats
 *   getTaxReport      → GET    /admin/billing/tax-report
 *
 * There is no `createInvoice` or `createPayment`, and that is deliberate
 * rather than missing: both are produced by *placing an order*, inside the
 * transaction that also takes the stock and records the coupon. A route that
 * made one on its own would be a way to have an invoice nothing pays for.
 *
 * Filtering and aggregation are the server's job. The UI asks a question; it
 * does not download a table and answer it itself.
 */

export interface InvoiceQuery {
  search?: string;
  status?: Invoice["status"] | "all";
  paymentStatus?: Payment["status"] | "all";
  customerId?: string;
  orderId?: string;
  /** ISO dates, inclusive. */
  from?: string;
  to?: string;
  /** Minor units. */
  minAmount?: number;
  maxAmount?: number;
}

export interface PaymentQuery {
  search?: string;
  status?: Payment["status"] | "all";
  method?: Payment["method"] | "all";
  customerId?: string;
  orderId?: string;
  from?: string;
  to?: string;
}

export interface RefundQuery {
  search?: string;
  status?: Refund["status"] | "all";
  orderId?: string;
  customerId?: string;
}

/** What raising a refund needs. The number, the tax and the settlement are the server's. */
export interface RefundDraft {
  invoiceId: string;
  amount: Money;
  reason: string;
  /** Empty for a whole-order refund; populated for a per-item one. */
  lines?: RefundLine[];
  /** `requested` leaves it awaiting action; `completed` settles it immediately. */
  status?: RefundStatus;
}

/** What issuing a credit note needs. Its tax is recomputed server-side from `total`. */
export interface CreditNoteDraft {
  invoiceId: string;
  total: Money;
  reason: string;
  refundId?: string | null;
  status?: CreditNoteStatus;
}

export interface BillingDataSource {
  listInvoices(query?: InvoiceQuery): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice | null>;

  /**
   * The signed-in customer's own invoices.
   *
   * A separate pair of methods rather than a filter on the admin ones, because
   * they are a different endpoint with a different token and a different
   * answer to "whose is this?". Sharing one method would mean a customer page
   * calling an admin route and quietly getting nothing back.
   */
  listMyInvoices(): Promise<Invoice[]>;
  getMyInvoice(id: string): Promise<Invoice | null>;
  getInvoiceByOrderId(orderId: string): Promise<Invoice | null>;
  updateInvoice(invoice: Invoice): Promise<Invoice>;

  listPayments(query?: PaymentQuery): Promise<Payment[]>;
  getPayment(id: string): Promise<Payment | null>;
  getPaymentByOrderId(orderId: string): Promise<Payment | null>;
  updatePayment(payment: Payment): Promise<Payment>;

  listRefunds(query?: RefundQuery): Promise<Refund[]>;
  getRefund(id: string): Promise<Refund | null>;
  createRefund(draft: RefundDraft): Promise<Refund>;
  updateRefund(refund: Refund): Promise<Refund>;

  listCreditNotes(): Promise<CreditNote[]>;
  getCreditNote(id: string): Promise<CreditNote | null>;
  createCreditNote(draft: CreditNoteDraft): Promise<CreditNote>;
  updateCreditNote(note: CreditNote): Promise<CreditNote>;

  /** Aggregates over a date window. Omitting the window means all time. */
  getStats(from?: string, to?: string): Promise<BillingStats>;
  getTaxReport(from?: string, to?: string): Promise<TaxReportRow[]>;
}
