"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea, AdminToggle } from "@/components/admin/ui/AdminForm";
import { Modal } from "@/components/ui/Dialog";
import { formatMoney } from "@/lib/money";
import { ApiError } from "@/services/api/client";
import { calculateRefund, createOrderRefund } from "@/services/admin/refundsAdminService";
import { toast } from "@/store/toastStore";
import type { RefundBreakdown, RefundMethod, RefundRecord, RefundRequest } from "@/types/refunds";
import { REFUND_METHOD_LABELS } from "@/types/refunds";

/**
 * Rupees as typed ("120", "120.5", "120.50") to whole paise, without going
 * through a floating-point number. `null` for anything that isn't an amount.
 */
export function rupeesToPaise(text: string): number | null {
  const value = text.trim().replace(/,/g, "");
  if (value === "") return 0;
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

function paiseToRupees(paise: number): string {
  const whole = Math.floor(paise / 100);
  const part = paise % 100;
  return part ? `${whole}.${String(part).padStart(2, "0")}` : String(whole);
}

function newKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `refund-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

const money = (paise: number) => formatMoney(paise, { showDecimals: true });

/**
 * Refund some or all of an order: which items and how many, the delivery fee,
 * an extra goodwill amount, how it goes back and why. Every figure on the
 * page — each line's share of discount and tax, the total, how it splits
 * between the payment and any gift card or store credit — is the server's
 * calculation for what's chosen; nothing is added up here. The server checks
 * it all again when the refund is raised, and a key sent with it means a
 * double click or a retry after a dropped connection can't refund twice.
 */
export function RefundWizard({
  orderId,
  initial,
  onClose,
  onDone,
}: {
  orderId: string;
  initial: RefundBreakdown;
  onClose: () => void;
  onDone: (refund: RefundRecord) => void;
}) {
  const [quantities, setQuantities] = useState<Record<number, string>>(() =>
    Object.fromEntries(initial.lines.map((line) => [line.orderItemId, "0"])));
  const [includeShipping, setIncludeShipping] = useState(false);
  const [shipping, setShipping] = useState(paiseToRupees(initial.shipping.refundable));
  const [adjustment, setAdjustment] = useState("");
  const [method, setMethod] = useState<RefundMethod>(initial.method);
  const [reasonCode, setReasonCode] = useState("");
  const [reason, setReason] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [manualReference, setManualReference] = useState("");
  const [breakdown, setBreakdown] = useState<RefundBreakdown>(initial);
  const [calcError, setCalcError] = useState("");
  const [calculating, setCalculating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [idempotencyKey] = useState(newKey);

  // What's chosen, as the request; `null` while a field can't be read.
  const request = useMemo<RefundRequest | null>(() => {
    const lines = [];
    for (const line of initial.lines) {
      const text = quantities[line.orderItemId] ?? "0";
      const quantity = text === "" ? 0 : Number(text);
      if (!Number.isInteger(quantity) || quantity < 0) return null;
      if (quantity > 0) lines.push({ orderItemId: line.orderItemId, quantity });
    }
    const adjustmentAmount = rupeesToPaise(adjustment);
    const shippingAmount = includeShipping ? rupeesToPaise(shipping) : 0;
    if (adjustmentAmount === null || shippingAmount === null) return null;
    return {
      lines,
      ...(includeShipping ? { includeShipping: true, shippingAmount } : {}),
      ...(adjustmentAmount ? { adjustmentAmount } : {}),
      method,
    };
  }, [initial.lines, quantities, includeShipping, shipping, adjustment, method]);
  const requestKey = JSON.stringify(request);

  // Ask the server for the breakdown of what's chosen, a moment after the last change.
  useEffect(() => {
    if (!request) return;
    let live = true;
    const timer = setTimeout(() => {
      setCalculating(true);
      calculateRefund(orderId, request)
        .then((next) => {
          if (!live) return;
          setBreakdown(next);
          setCalcError("");
        })
        .catch((error: unknown) => {
          if (live) setCalcError(error instanceof ApiError ? error.message : "The refund couldn't be worked out.");
        })
        .finally(() => live && setCalculating(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `requestKey` stands for `request`: a new object with the same content isn't a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, requestKey]);

  const refundAll = () => {
    setQuantities(Object.fromEntries(initial.lines.map((line) => [line.orderItemId, String(line.refundable)])));
    if (initial.shipping.refundable > 0) {
      setIncludeShipping(true);
      setShipping(paiseToRupees(initial.shipping.refundable));
    }
  };

  const total = breakdown.totals.total;
  const current = !calculating && !calcError && request !== null;
  const canSubmit = current && total > 0 && reasonCode !== "" && !saving;

  const submit = async () => {
    if (!request || !canSubmit) return;
    setSaving(true);
    try {
      const refund = await createOrderRefund(orderId, {
        ...request, idempotencyKey, reasonCode, reason: reason.trim(), internalNote: internalNote.trim(),
        manualReference: manualReference.trim(),
      });
      const done = refund.status === "failed" ? toast.error : toast.success;
      done(refund.status === "completed" ? `${money(refund.amount)} refunded — ${refund.refundNumber}`
        : refund.status === "requested" ? `${refund.refundNumber} is waiting for approval.`
          : refund.status === "failed" ? "The payment gateway declined this refund. You can retry it."
            : `${refund.refundNumber} sent; the gateway will confirm it.`);
      onDone(refund);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "The refund wasn't raised. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const linesById = new Map(breakdown.lines.map((line) => [line.orderItemId, line]));
  const nothingLeft = initial.remaining <= 0;

  return (
    <Modal open onOpenChange={(open) => !open && !saving && onClose()} title={`Refund order #${initial.orderNumber}`}
      className="max-w-3xl">
      <div className="flex flex-col gap-4 text-xs">
        <p className="text-admin-muted">
          Paid {money(initial.paid.total)} · refunded so far {money(initial.refunded)} ·{" "}
          <span className="font-medium text-admin-ink">{money(initial.remaining)} left to refund</span>
          {initial.isCod ? " · cash on delivery" : ""}
        </p>

        {nothingLeft ? (
          <p role="alert" className="text-admin-ink">Everything paid on this order has already been refunded.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left">
                <thead className="border-b border-admin-border text-admin-muted">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Item</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Bought</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Refunded</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Refund now</th>
                    <th className="py-1.5 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-admin-border">
                  {initial.lines.map((line) => {
                    const priced = linesById.get(line.orderItemId);
                    const text = quantities[line.orderItemId] ?? "0";
                    const over = Number(text) > line.refundable;
                    return (
                      <tr key={line.orderItemId} className="align-top">
                        <td className="py-2 pr-3">
                          <span className="text-admin-ink">{line.name}</span>
                          <span className="block text-admin-muted">
                            {[line.sku, line.size, line.color].filter(Boolean).join(" · ")} · {money(line.unitPrice)} each
                            {line.returned ? ` · ${line.returned} returned` : ""}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{line.ordered}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-admin-muted">{line.refunded}</td>
                        <td className="py-2 pr-3 text-right">
                          <input aria-label={`Units of ${line.name} to refund`} inputMode="numeric" value={text}
                            disabled={line.refundable === 0}
                            aria-invalid={over || undefined}
                            onChange={(event) => setQuantities((current) => ({
                              ...current, [line.orderItemId]: event.target.value.replace(/\D/g, ""),
                            }))}
                            className="h-7 w-14 rounded-[3px] border border-admin-border px-1.5 text-right tabular-nums disabled:opacity-50" />
                          <span className="block text-[0.625rem] text-admin-muted">of {line.refundable}</span>
                        </td>
                        <td className="py-2 text-right tabular-nums text-admin-ink">
                          {priced && priced.quantity ? money(priced.amount) : "—"}
                          {priced && priced.quantity && priced.tax ? (
                            <span className="block text-[0.625rem] text-admin-muted">incl. {money(priced.tax)} tax</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <AdminButton size="sm" onClick={refundAll}>Refund everything left</AdminButton>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <AdminToggle label="Refund delivery" checked={includeShipping}
                  disabled={initial.shipping.refundable === 0}
                  description={initial.shipping.refundable
                    ? `Up to ${money(initial.shipping.refundable)} of the ${money(initial.shipping.charged)} charged.`
                    : "No delivery fee left to refund."}
                  onChange={setIncludeShipping} />
                {includeShipping ? (
                  <AdminInput label="Delivery to refund (₹)" inputMode="decimal" value={shipping}
                    error={rupeesToPaise(shipping) === null ? "Enter an amount like 49 or 49.50." : undefined}
                    onChange={(event) => setShipping(event.target.value)} />
                ) : null}
                {breakdown.suggestShipping && !includeShipping ? (
                  <p className="mt-1 text-[0.6875rem] text-[#8a5a12]">Every item is being refunded — refund the delivery too?</p>
                ) : null}
              </div>
              <AdminInput label="Extra amount (₹, optional)" inputMode="decimal" value={adjustment}
                hint="A goodwill amount on top of the items, such as a price adjustment."
                error={rupeesToPaise(adjustment) === null ? "Enter an amount like 100 or 99.50." : undefined}
                onChange={(event) => setAdjustment(event.target.value)} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <AdminSelect label="Refund to" value={method} onChange={(event) => setMethod(event.target.value as RefundMethod)}
                options={initial.allowedMethods.map((value) => ({ value, label: REFUND_METHOD_LABELS[value] ?? value }))} />
              <AdminSelect label="Reason" value={reasonCode} required onChange={(event) => setReasonCode(event.target.value)}
                options={[{ value: "", label: "Choose a reason" },
                  ...initial.reasonCodes.map((entry) => ({ value: entry.code, label: entry.label }))]} />
              <AdminTextarea label="Note for the customer (optional)" rows={2} maxLength={255} value={reason}
                onChange={(event) => setReason(event.target.value)} />
              <AdminTextarea label="Internal note (optional)" rows={2} maxLength={1000} value={internalNote}
                hint="Staff only; never shown to the customer." onChange={(event) => setInternalNote(event.target.value)} />
              {initial.isCod && method === "original" ? (
                <AdminInput label="Bank / UPI transfer reference" value={manualReference} maxLength={120}
                  hint="Cash on delivery goes back by transfer; record its reference."
                  onChange={(event) => setManualReference(event.target.value)} />
              ) : null}
            </div>

            <section aria-label="Refund summary" aria-busy={calculating}
              className="rounded-[3px] border border-admin-border bg-admin-raised p-3">
              {calcError ? (
                <p role="alert" className="flex gap-1.5 text-[#a12b2b]">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{calcError}
                </p>
              ) : (
                <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 tabular-nums">
                  <dt className="text-admin-muted">Items</dt><dd className="text-right">{money(breakdown.totals.items)}</dd>
                  <dt className="text-admin-muted">Delivery</dt><dd className="text-right">{money(breakdown.totals.shipping)}</dd>
                  <dt className="text-admin-muted">Extra amount</dt><dd className="text-right">{money(breakdown.totals.adjustment)}</dd>
                  <dt className="text-admin-muted">of which tax</dt><dd className="text-right">{money(breakdown.totals.tax)}</dd>
                  <dt className="font-medium text-admin-ink">Refund total</dt>
                  <dd className="text-right font-medium text-admin-ink" data-testid="refund-total">{money(total)}</dd>
                  {breakdown.split.tenders > 0 ? (
                    <>
                      <dt className="text-admin-muted">To the payment</dt><dd className="text-right">{money(breakdown.split.payment)}</dd>
                      <dt className="text-admin-muted">To gift card / credit / points used</dt>
                      <dd className="text-right">{money(breakdown.split.tenders)}</dd>
                    </>
                  ) : null}
                </dl>
              )}
              {!calcError && breakdown.requiresApproval ? (
                <p className="mt-2 text-[#8a5a12]">
                  Above {formatMoney(breakdown.approvalThreshold)}: it&rsquo;s recorded now and sent once a manager approves it.
                </p>
              ) : null}
            </section>
          </>
        )}

        <div className="flex justify-end gap-2">
          <AdminButton disabled={saving} onClick={onClose}>Cancel</AdminButton>
          {nothingLeft ? null : (
            <AdminButton variant="primary" disabled={!canSubmit} loading={saving} onClick={() => void submit()}>
              {breakdown.requiresApproval ? "Request refund" : "Refund"} {current && total > 0 ? money(total) : ""}
            </AdminButton>
          )}
        </div>
      </div>
    </Modal>
  );
}
