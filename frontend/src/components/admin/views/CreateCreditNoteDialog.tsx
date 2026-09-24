"use client";

import { useEffect, useState } from "react";

import type { Invoice } from "@/types";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea } from "@/components/admin/ui/AdminForm";
import { Modal } from "@/components/ui/Dialog";
import { formatMoney, toMinor } from "@/lib/money";
import { useRefundReasons, useTaxConfig } from "@/hooks/useBillingConfig";
import { createCreditNote } from "@/services/billing/creditNoteService";
import { EMPTY_TAX, calculateTax } from "@/services/billing/taxService";
import { toast } from "@/store/toastStore";

/**
 * Issue a credit note against an invoice.
 *
 * The tax on it is recomputed from the amount being credited rather than taken
 * from the invoice, so a partial credit carries its own proportion of tax and
 * the note reconciles with the document it offsets. That happens on the
 * server; the split shown here is a preview of it, so whoever issues the note
 * can see what they are crediting before they commit.
 *
 * Drafting is offered because a credit note is a document, and documents get
 * checked before they are issued.
 */
export function CreateCreditNoteDialog({
  open,
  onOpenChange,
  invoice,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice;
  onDone: () => Promise<void> | void;
}) {
  const [amountInput, setAmountInput] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [asDraft, setAsDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasons = useRefundReasons();
  const taxConfig = useTaxConfig();

  useEffect(() => {
    if (!open) return;
    setAmountInput(String(Math.round(invoice.breakdown.grandTotal / 100)));
    setNote("");
    setAsDraft(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The reasons are fetched, so the default is chosen when they arrive rather
  // than when the dialog opens — otherwise the select starts blank.
  useEffect(() => {
    if (open && !reason) setReason(reasons[0] ?? "");
  }, [open, reason, reasons]);

  const total = toMinor(Number(amountInput) || 0);
  const tax = taxConfig
    ? calculateTax(total, invoice.placeOfSupply, null, taxConfig)
    : EMPTY_TAX;

  const submit = async () => {
    setBusy(true);
    const result = await createCreditNote({
      invoiceId: invoice.id,
      total,
      reason: note.trim() ? `${reason} — ${note.trim()}` : reason,
      status: asDraft ? "draft" : "issued",
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.reason);
      return;
    }

    toast.success(
      `${result.creditNote.creditNoteNumber} ${asDraft ? "drafted" : "issued"} for ${formatMoney(total)}`,
    );
    onOpenChange(false);
    await onDone();
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create credit note"
      description={`Against ${invoice.invoiceNumber}`}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <AdminInput
            label="Credit amount (₹)"
            type="number"
            min={0}
            value={amountInput}
            onChange={(event) => {
              setAmountInput(event.target.value);
              setError(null);
            }}
            hint={`Invoice total is ${formatMoney(invoice.breakdown.grandTotal)}`}
          />

          <AdminSelect
            label="Reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            options={reasons.map((entry) => ({ value: entry, label: entry }))}
          />
        </div>

        <AdminTextarea
          label="Note"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          hint="Optional. Appears on the credit note alongside the reason."
        />

        {/* The tax split, so it is checked before it is issued and not after. */}
        <dl className="flex flex-col gap-1.5 rounded-[3px] border border-admin-border bg-admin-raised p-3 text-xs">
          <Row label="Taxable value" value={formatMoney(tax.taxableAmount)} />
          {tax.mode === "intra-state" ? (
            <>
              <Row label="CGST" value={formatMoney(tax.cgst)} />
              <Row label="SGST" value={formatMoney(tax.sgst)} />
            </>
          ) : (
            <Row label={`IGST (${tax.ratePercent}%)`} value={formatMoney(tax.igst)} />
          )}
          <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-admin-border pt-1.5">
            <dt className="font-medium text-admin-ink">Credit total</dt>
            <dd className="font-semibold tabular-nums text-admin-ink">{formatMoney(total)}</dd>
          </div>
        </dl>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-admin-muted">
          <input
            type="checkbox"
            checked={asDraft}
            onChange={(event) => setAsDraft(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--color-admin-ink)]"
          />
          Save as a draft rather than issuing it now
        </label>

        {error ? (
          <p role="alert" className="text-xs text-status-critical">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <AdminButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </AdminButton>
          <AdminButton variant="primary" onClick={() => void submit()} disabled={busy || total <= 0}>
            {asDraft ? "Save draft" : "Issue credit note"}
          </AdminButton>
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-admin-muted">{label}</dt>
      <dd className="tabular-nums text-admin-ink">{value}</dd>
    </div>
  );
}
