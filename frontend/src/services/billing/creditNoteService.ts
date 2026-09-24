import type { CreditNote, CreditNoteStatus, Money } from "@/types";

import { ApiError } from "@/services/api/client";

import { billingDataSource } from "./billing-data-source.instance";

/**
 * Credit notes.
 *
 * A refund returns money; a credit note is the document saying an invoice's
 * value has been reduced, and carries the tax adjustment that goes with it.
 * They are separate records because they are separate events — money can go
 * back before a note is raised, and a note can be drafted before it is issued.
 *
 * The number and the tax are the server's. Its tax is recomputed from the
 * credited amount rather than copied off the invoice, so a partial credit
 * carries the right proportion and the note reconciles with the document it
 * offsets — and it is recomputed by the same code that wrote that document.
 *
 *   GET  /admin/billing/credit-notes
 *   POST /admin/billing/credit-notes
 *   PUT  /admin/billing/credit-notes/:id
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
  invoiceId: string;
  /** The gross amount being credited. */
  total: Money;
  reason: string;
  refundId?: string | null;
  status?: CreditNoteStatus;
}

export type CreditNoteResult =
  | { ok: true; creditNote: CreditNote }
  | { ok: false; reason: string };

export async function createCreditNote(input: CreateCreditNoteInput): Promise<CreditNoteResult> {
  if (input.total <= 0) return { ok: false, reason: "Enter an amount above zero." };
  if (!input.reason.trim()) return { ok: false, reason: "Give a reason for the credit note." };

  try {
    const creditNote = await billingDataSource.createCreditNote({
      invoiceId: input.invoiceId,
      total: input.total,
      reason: input.reason.trim(),
      refundId: input.refundId,
      status: input.status,
    });
    return { ok: true, creditNote };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ApiError && error.message
          ? error.message
          : "The credit note could not be issued.",
    };
  }
}

export function setCreditNoteStatus(
  note: CreditNote,
  status: CreditNoteStatus,
): Promise<CreditNote> {
  return billingDataSource.updateCreditNote({ ...note, status });
}
