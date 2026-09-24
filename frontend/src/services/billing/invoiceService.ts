import type { Invoice, InvoiceStatus, Money } from "@/types";

import { billingDataSource } from "./billing-data-source.instance";
import type { InvoiceQuery } from "./billing-data-source";

/**
 * Invoices.
 *
 * Reading and the one edit the portal makes. Everything else an invoice needs
 * — its number, its due date, its line tax, its totals — is decided by the
 * server, inside the transaction that places the order.
 *
 * That is a change worth naming. This file used to mint invoice numbers in the
 * browser from a counter in local storage. Two tabs would mint the same one,
 * two devices certainly would, and a duplicate invoice number is not a display
 * bug: it is a bookkeeping problem that outlives the session. Sequential,
 * gapless numbering is a property only a single authority can provide, so the
 * authority is `services/invoices.py`.
 *
 *   GET  /admin/billing/invoices
 *   GET  /admin/billing/invoices/:id
 *   POST /admin/billing/invoices/:id/mark-paid
 *   GET  /invoices              — a customer's own
 */

/* ----------------------------------------------------------------- reading */

export function getInvoices(query?: InvoiceQuery): Promise<Invoice[]> {
  return billingDataSource.listInvoices(query);
}

export function getInvoiceById(id: string): Promise<Invoice | null> {
  return billingDataSource.getInvoice(id);
}

export function getInvoiceByOrderId(orderId: string): Promise<Invoice | null> {
  return billingDataSource.getInvoiceByOrderId(orderId);
}

/**
 * The signed-in customer's own invoices, newest first.
 *
 * A different endpoint from the portal's, not a filter on it: the server
 * decides whose these are, from the token. Asking the admin route with a
 * customer's credentials is how the account page came to show nothing at all.
 */
export function getMyInvoices(): Promise<Invoice[]> {
  return billingDataSource.listMyInvoices();
}

export function getMyInvoice(id: string): Promise<Invoice | null> {
  return billingDataSource.getMyInvoice(id);
}

/* ----------------------------------------------------------------- writing */

export function updateInvoice(invoice: Invoice): Promise<Invoice> {
  return billingDataSource.updateInvoice(invoice);
}

/**
 * Record a settlement against an invoice.
 *
 * The amount is sent; the resulting status is the server's to decide, because
 * "is this paid" answered in two places is how the two come to disagree. A
 * partial settlement is a real state, and the invoice that comes back says
 * which one it is now in.
 */
export function markInvoicePaid(
  invoice: Invoice,
  amount: Money = invoice.breakdown.grandTotal - invoice.amountPaid,
): Promise<Invoice> {
  const amountPaid = Math.min(
    invoice.breakdown.grandTotal,
    invoice.amountPaid + Math.max(0, amount),
  );
  return updateInvoice({ ...invoice, amountPaid });
}

export function setInvoiceStatus(invoice: Invoice, status: InvoiceStatus): Promise<Invoice> {
  return updateInvoice({ ...invoice, status });
}

/* ------------------------------------------------------------- derivations */

/**
 * Whether an invoice is past its due date and still owed.
 *
 * Derived rather than stored: a stored "overdue" flag is wrong the morning
 * after it was written, and nothing runs overnight to correct it.
 */
export function isOverdue(invoice: Invoice, now: Date = new Date()): boolean {
  if (invoice.status === "paid" || invoice.status === "cancelled") return false;
  if (invoice.amountPaid >= invoice.breakdown.grandTotal) return false;
  return new Date(invoice.dueAt).getTime() < now.getTime();
}

/** What is still owed on an invoice. */
export function amountDue(invoice: Invoice): Money {
  return Math.max(0, invoice.breakdown.grandTotal - invoice.amountPaid - invoice.amountRefunded);
}
