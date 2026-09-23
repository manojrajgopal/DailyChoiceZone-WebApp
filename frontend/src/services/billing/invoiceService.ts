import creditNotesJson from "@/data/billing/credit-notes.json";
import invoicesJson from "@/data/billing/invoices.json";

import type {
  BillingAddress,
  CreditNote,
  BillingBreakdown,
  BillingPaymentStatus,
  Invoice,
  InvoiceLine,
  InvoiceStatus,
  Money,
} from "@/types";

import { OVERLAY_KEYS, readDocument, writeDocument } from "@/lib/admin/mock-store";

import { billingDataSource } from "./billing-data-source.instance";
import type { InvoiceQuery } from "./billing-data-source";
import { getBillingConfig } from "./billingService";

/**
 * Invoices.
 *
 * Future: `GET /billing/invoices`, `GET /billing/invoices/:id`,
 * `POST /billing/invoices`, `PUT /billing/invoices/:id`.
 */

/* --------------------------------------------------------------- numbering */

interface Sequences {
  invoice: number;
  creditNote: number;
}

/**
 * The highest number already used in a committed series.
 *
 * A counter that starts at 1 regardless of what shipped would re-issue numbers
 * the demo data already contains — two documents with the same reference, which
 * is the one thing a numbering scheme exists to prevent.
 */
function highestCommitted(numbers: string[]): number {
  return numbers.reduce((highest, value) => {
    const digits = Number.parseInt(value.split("-").pop() ?? "", 10);
    return Number.isFinite(digits) && digits > highest ? digits : highest;
  }, 0);
}

function readSequences(): Sequences {
  const config = getBillingConfig();

  const committedInvoices = (invoicesJson as unknown as Invoice[]).map(
    (invoice) => invoice.invoiceNumber,
  );
  const committedNotes = (creditNotesJson as unknown as CreditNote[]).map(
    (note) => note.creditNoteNumber,
  );

  const fallback: Sequences = {
    invoice: Math.max(highestCommitted(committedInvoices) + 1, config.invoice.startNumber),
    creditNote: Math.max(highestCommitted(committedNotes) + 1, config.creditNote.startNumber),
  };

  return readDocument(OVERLAY_KEYS.billingSequences, fallback);
}

/**
 * Invoice numbering.
 *
 * One function issues every invoice number, because a number generated in a
 * component is a number that can be generated twice — on a re-render, on a
 * double-submitted form, in two tabs at once. A duplicate invoice number is not
 * a display bug; it is a bookkeeping problem that outlives the session.
 *
 * The counter starts above whatever the committed data already used, so a
 * freshly generated demo and a browser that has been placing orders for a week
 * both continue the same sequence rather than colliding with it.
 *
 * **A browser cannot actually guarantee this.** Two devices will happily mint
 * the same number, because neither can see the other. Sequential, gapless
 * numbering is a property only a single authority can provide, so the backend
 * must own it: `POST /billing/invoices` returns the number, and this function
 * becomes a local placeholder shown until the server answers. The shape does
 * not change — only who is allowed to decide.
 */
export function nextInvoiceNumber(issuedAt: Date = new Date()): {
  id: string;
  invoiceNumber: string;
} {
  const config = getBillingConfig();
  const sequences = readSequences();
  const value = sequences.invoice;

  writeDocument(OVERLAY_KEYS.billingSequences, { ...sequences, invoice: value + 1 });

  return {
    id: `inv_${String(value).padStart(4, "0")}`,
    invoiceNumber: `${config.invoice.prefix}-${issuedAt.getFullYear()}-${String(value).padStart(config.invoice.padding, "0")}`,
  };
}

export function nextCreditNoteNumber(issuedAt: Date = new Date()): {
  id: string;
  creditNoteNumber: string;
} {
  const config = getBillingConfig();
  const sequences = readSequences();
  const value = sequences.creditNote;

  writeDocument(OVERLAY_KEYS.billingSequences, { ...sequences, creditNote: value + 1 });

  return {
    id: `cn_${String(value).padStart(4, "0")}`,
    creditNoteNumber: `${config.creditNote.prefix}-${issuedAt.getFullYear()}-${String(value).padStart(config.creditNote.padding, "0")}`,
  };
}

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

/** A customer's own invoices, newest first. */
export function getInvoicesForCustomer(customerId: string): Promise<Invoice[]> {
  return billingDataSource.listInvoices({ customerId });
}

/* ----------------------------------------------------------------- writing */

export interface CreateInvoiceInput {
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  billingAddress: BillingAddress;
  shippingAddress: BillingAddress;
  lines: InvoiceLine[];
  breakdown: BillingBreakdown;
  paymentMethod: Invoice["paymentMethod"];
  paymentStatus: BillingPaymentStatus;
  paymentId: string | null;
  issuedAt?: Date;
}

export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const config = getBillingConfig();
  const issuedAt = input.issuedAt ?? new Date();
  const { id, invoiceNumber } = nextInvoiceNumber(issuedAt);

  const settled = input.paymentStatus === "paid";

  const invoice: Invoice = {
    id,
    invoiceNumber,
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    customerId: input.customerId,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    status: settled ? "paid" : "issued",
    issuedAt: issuedAt.toISOString(),
    dueAt: new Date(issuedAt.getTime() + config.invoice.dueDays * 86400000).toISOString(),
    billingAddress: input.billingAddress,
    shippingAddress: input.shippingAddress,
    placeOfSupply: input.billingAddress.state,
    lines: input.lines,
    breakdown: input.breakdown,
    paymentId: input.paymentId,
    paymentMethod: input.paymentMethod,
    paymentStatus: input.paymentStatus,
    amountPaid: settled ? input.breakdown.grandTotal : 0,
    amountRefunded: 0,
    notes: config.invoice.notes,
    terms: config.invoice.paymentTerms,
  };

  return billingDataSource.createInvoice(invoice);
}

export function updateInvoice(invoice: Invoice): Promise<Invoice> {
  return billingDataSource.updateInvoice(invoice);
}

/**
 * Record a payment against an invoice.
 *
 * Accepts a partial settlement, because part-paid is a real state and an
 * invoice that can only be "paid" or "unpaid" cannot represent it. The status
 * follows the arithmetic rather than being passed in separately — two sources
 * of truth for "is this paid" is how they come to disagree.
 */
export async function markInvoicePaid(
  invoice: Invoice,
  amount: Money = invoice.breakdown.grandTotal - invoice.amountPaid,
  paymentStatus: BillingPaymentStatus = "paid",
): Promise<Invoice> {
  const amountPaid = Math.min(invoice.breakdown.grandTotal, invoice.amountPaid + Math.max(0, amount));
  const fullySettled = amountPaid >= invoice.breakdown.grandTotal;

  return updateInvoice({
    ...invoice,
    amountPaid,
    paymentStatus: fullySettled ? paymentStatus : "pending",
    status: fullySettled ? "paid" : invoice.status === "draft" ? "issued" : invoice.status,
  });
}

export function setInvoiceStatus(invoice: Invoice, status: InvoiceStatus): Promise<Invoice> {
  return updateInvoice({ ...invoice, status });
}

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
