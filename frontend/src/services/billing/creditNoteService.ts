import type { CreditNote, CreditNoteStatus, Invoice, Money, Refund } from "@/types";

import { billingDataSource } from "./billing-data-source.instance";
import { nextCreditNoteNumber } from "./invoiceService";
import { linkCreditNote } from "./refundService";
import { calculateTax } from "./taxService";

/**
 * Credit notes.
 *
 * A refund returns money; a credit note is the document that says an invoice's
 * value has been reduced, and carries the tax adjustment that goes with it. They
 * are separate records because they are separate events — money can go back
 * without a note being raised yet, and a note can be drafted before it is
 * issued.
 *
 * Its tax is recomputed from the credited amount rather than copied off the
 * invoice, so a partial credit carries the right proportion of tax and the note
 * reconciles with the invoice it offsets.
 *
 * Future: `GET /billing/credit-notes`, `POST /billing/credit-notes`.
 */

export function getCreditNotes(): Promise<CreditNote[]> {
  return billingDataSource.listCreditNotes();
}

export function getCreditNoteById(id: string): Promise<CreditNote | null> {
  return billingDataSource.getCreditNote(id);
}

export async function getCreditNotesForOrder(orderId: string): Promise<CreditNote[]> {
  const notes = await billingDataSource.listCreditNotes();
  return notes.filter((note) => note.orderId === orderId);
}

export interface CreateCreditNoteInput {
  invoice: Invoice;
  /** The gross amount being credited. */
  total: Money;
  reason: string;
  refund?: Refund | null;
  status?: CreditNoteStatus;
}

export type CreditNoteResult =
  | { ok: true; creditNote: CreditNote }
  | { ok: false; reason: string };

export async function createCreditNote(input: CreateCreditNoteInput): Promise<CreditNoteResult> {
  const { invoice, total, reason } = input;

  if (total <= 0) {
    return { ok: false, reason: "Enter an amount above zero." };
  }
  if (total > invoice.breakdown.grandTotal) {
    return { ok: false, reason: "A credit note cannot exceed the invoice it offsets." };
  }
  if (!reason.trim()) {
    return { ok: false, reason: "Give a reason for the credit note." };
  }

  const now = new Date();
  const { id, creditNoteNumber } = nextCreditNoteNumber(now);
  const tax = calculateTax(total, invoice.placeOfSupply, null);

  const note: CreditNote = {
    id,
    creditNoteNumber,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    orderId: invoice.orderId,
    orderNumber: invoice.orderNumber,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    refundId: input.refund?.id ?? null,
    reason: reason.trim(),
    amount: tax.taxableAmount,
    tax: tax.totalTax,
    total,
    issuedAt: now.toISOString(),
    status: input.status ?? "issued",
  };

  await billingDataSource.createCreditNote(note);

  // Keep the refund pointing at its note, so either record leads to the other.
  if (input.refund) await linkCreditNote(input.refund, note.id);

  return { ok: true, creditNote: note };
}

export function setCreditNoteStatus(
  note: CreditNote,
  status: CreditNoteStatus,
): Promise<CreditNote> {
  return billingDataSource.updateCreditNote({ ...note, status });
}
