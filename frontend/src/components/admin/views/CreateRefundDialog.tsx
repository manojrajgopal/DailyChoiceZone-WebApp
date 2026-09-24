"use client";

import { useEffect, useMemo, useState } from "react";

import type { Invoice, Payment, RefundLine } from "@/types";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect } from "@/components/admin/ui/AdminForm";
import { Modal } from "@/components/ui/Dialog";
import { formatMoney, toMinor } from "@/lib/money";
import { useRefundReasons } from "@/hooks/useBillingConfig";
import { createRefund } from "@/services/billing/refundService";
import { refundableAmount } from "@/services/billing/paymentService";
import { toast } from "@/store/toastStore";

/**
 * Raise a refund against an invoice.
 *
 * Two shapes, because both are real: the whole order, or specific items. The
 * item mode sums the chosen lines and shows the figure rather than asking
 * anyone to add it up — a refund amount typed by hand is a refund amount typed
 * wrong.
 *
 * The amount is capped at what the *payment* has left rather than what the
 * invoice was worth, because two partial refunds that each look reasonable can
 * together exceed what was actually collected. The server refuses that as
 * well — and who raised it is taken from the token, not sent from here. The
 * cap on this form is so the administrator finds out before they submit.
 */
export function CreateRefundDialog({
  open,
  onOpenChange,
  invoice,
  payment,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice;
  payment: Payment | null;
  onDone: () => Promise<void> | void;
}) {
  const [mode, setMode] = useState<"full" | "items">("full");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = payment ? refundableAmount(payment) : 0;
  const reasons = useRefundReasons();

  const lineKey = (index: number) => `${invoice.lines[index]?.productId ?? ""}-${index}`;

  const itemsTotal = useMemo(
    () =>
      invoice.lines.reduce(
        (total, line, index) => (selected.has(lineKey(index)) ? total + line.lineTotal : total),
        0,
      ),
    // `selected` and the invoice are the only inputs; lineKey is derived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [invoice.lines, selected],
  );

  /** Reset each time the dialog opens, so a cancelled attempt leaves nothing behind. */
  useEffect(() => {
    if (!open) return;
    setMode("full");
    setSelected(new Set());
    setAmountInput(String(Math.round(available / 100)));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The reasons are fetched, so the default is chosen when they arrive rather
  // than when the dialog opens — otherwise the select starts blank.
  useEffect(() => {
    if (open && !reason) setReason(reasons[0] ?? "");
  }, [open, reason, reasons]);

  useEffect(() => {
    if (mode === "items") setAmountInput(String(Math.round(itemsTotal / 100)));
  }, [mode, itemsTotal]);

  const amount = toMinor(Number(amountInput) || 0);

  const submit = async () => {
    if (!payment) {
      setError("This invoice has no payment to refund against.");
      return;
    }

    const lines: RefundLine[] =
      mode === "items"
        ? invoice.lines
            .map((line, index) => ({ line, index }))
            .filter(({ index }) => selected.has(lineKey(index)))
            .map(({ line }) => ({
              productId: line.productId,
              name: line.name,
              quantity: line.quantity,
              amount: line.lineTotal,
            }))
        : [];

    if (mode === "items" && lines.length === 0) {
      setError("Choose at least one item to refund.");
      return;
    }

    setBusy(true);
    const result = await createRefund({ invoiceId: invoice.id, amount, reason, lines });
    setBusy(false);

    if (!result.ok) {
      setError(result.reason);
      return;
    }

    toast.success(`${formatMoney(amount)} refunded — ${result.refund.refundNumber}`);
    onOpenChange(false);
    await onDone();
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Create refund"
      description={`Against ${invoice.invoiceNumber}`}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-admin-muted">
          {formatMoney(available)} of {formatMoney(invoice.breakdown.grandTotal)} is still
          refundable on this payment.
        </p>

        <fieldset>
          <legend className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
            What to refund
          </legend>
          <div className="flex gap-2">
            {(["full", "items"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={mode === option}
                className={
                  mode === option
                    ? "rounded-[3px] border border-admin-ink bg-admin-ink px-3 py-1.5 text-xs font-medium text-white"
                    : "rounded-[3px] border border-admin-border bg-admin-surface px-3 py-1.5 text-xs text-admin-muted hover:border-admin-border-strong hover:text-admin-ink"
                }
              >
                {option === "full" ? "Entire order" : "Specific items"}
              </button>
            ))}
          </div>
        </fieldset>

        {mode === "items" ? (
          <ul className="scroll-panel flex max-h-56 flex-col divide-y divide-admin-border overflow-y-auto rounded-[3px] border border-admin-border">
            {invoice.lines.map((line, index) => {
              const key = lineKey(index);
              return (
                <li key={key}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-xs hover:bg-admin-raised">
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={(event) => {
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(key);
                          else next.delete(key);
                          return next;
                        });
                      }}
                      className="h-3.5 w-3.5 shrink-0 accent-[var(--color-admin-ink)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-admin-ink">{line.name}</span>
                      <span className="block truncate text-[0.625rem] text-admin-faint">
                        {line.sku} · Qty {line.quantity}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums text-admin-ink">
                      {formatMoney(line.lineTotal)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <AdminInput
            label="Refund amount (₹)"
            type="number"
            min={0}
            value={amountInput}
            onChange={(event) => {
              setAmountInput(event.target.value);
              setError(null);
            }}
            hint={mode === "items" ? "Summed from the items chosen. Editable." : undefined}
          />

          <AdminSelect
            label="Reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            options={reasons.map((entry) => ({ value: entry, label: entry }))}
          />
        </div>

        {error ? (
          <p role="alert" className="text-xs text-status-critical">
            {error}
          </p>
        ) : null}

        <p className="text-[0.6875rem] leading-relaxed text-admin-faint">
          The refund is recorded against the payment and the invoice immediately. No money moves —
          there is no payment provider behind this.
        </p>

        <div className="flex justify-end gap-2">
          <AdminButton variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </AdminButton>
          <AdminButton variant="primary" onClick={() => void submit()} disabled={busy || amount <= 0}>
            Refund {formatMoney(amount)}
          </AdminButton>
        </div>
      </div>
    </Modal>
  );
}
