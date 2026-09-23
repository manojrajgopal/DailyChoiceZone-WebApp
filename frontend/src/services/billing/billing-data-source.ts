import type {
  BillingStats,
  CreditNote,
  Invoice,
  Payment,
  Refund,
  TaxReportRow,
} from "@/types";

/**
 * Where billing records come from.
 *
 * The same arrangement as `DataSource` and `AdminDataSource`: one contract, a
 * mock adapter over local JSON today, an HTTP adapter over a real API later.
 * Every method is shaped like the endpoint that will back it, named here so the
 * mapping is not something anyone has to infer:
 *
 *   listInvoices      → GET    /billing/invoices
 *   getInvoice        → GET    /billing/invoices/:id
 *   createInvoice     → POST   /billing/invoices
 *   updateInvoice     → PUT    /billing/invoices/:id
 *
 *   listPayments      → GET    /billing/payments
 *   getPayment        → GET    /billing/payments/:id
 *   createPayment     → POST   /billing/payments
 *   refundPayment     → POST   /billing/payments/:id/refund
 *
 *   listRefunds       → GET    /billing/refunds
 *   getRefund         → GET    /billing/refunds/:id
 *   createRefund      → POST   /billing/refunds
 *   updateRefund      → PUT    /billing/refunds/:id
 *
 *   listCreditNotes   → GET    /billing/credit-notes
 *   createCreditNote  → POST   /billing/credit-notes
 *
 *   getStats          → GET    /billing/reports
 *   getTaxReport      → GET    /billing/reports/tax
 *
 * Filtering and aggregation are the *data source's* job, not the UI's. Today
 * the mock adapter runs them over JSON; tomorrow the server runs them in SQL.
 * Either way the services ask the same question.
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

export interface BillingDataSource {
  listInvoices(query?: InvoiceQuery): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice | null>;
  getInvoiceByOrderId(orderId: string): Promise<Invoice | null>;
  createInvoice(invoice: Invoice): Promise<Invoice>;
  updateInvoice(invoice: Invoice): Promise<Invoice>;

  listPayments(query?: PaymentQuery): Promise<Payment[]>;
  getPayment(id: string): Promise<Payment | null>;
  getPaymentByOrderId(orderId: string): Promise<Payment | null>;
  createPayment(payment: Payment): Promise<Payment>;
  updatePayment(payment: Payment): Promise<Payment>;

  listRefunds(query?: RefundQuery): Promise<Refund[]>;
  getRefund(id: string): Promise<Refund | null>;
  createRefund(refund: Refund): Promise<Refund>;
  updateRefund(refund: Refund): Promise<Refund>;

  listCreditNotes(): Promise<CreditNote[]>;
  getCreditNote(id: string): Promise<CreditNote | null>;
  createCreditNote(note: CreditNote): Promise<CreditNote>;
  updateCreditNote(note: CreditNote): Promise<CreditNote>;

  /** Aggregates over a date window. Omitting the window means all time. */
  getStats(from?: string, to?: string): Promise<BillingStats>;
  getTaxReport(from?: string, to?: string): Promise<TaxReportRow[]>;
}
