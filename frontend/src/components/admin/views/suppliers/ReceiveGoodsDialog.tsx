"use client";

import { useState } from "react";

import type { PurchaseOrder } from "@/types/suppliers";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminTextarea } from "@/components/admin/ui/AdminForm";
import { Modal } from "@/components/ui/Dialog";
import { cn } from "@/lib/utils/cn";
import { receiveGoods } from "@/services/purchaseOrdersService";
import { toast } from "@/store/toastStore";

import { newKey, problem, serverFieldErrors, todayKey } from "./shared";
import { type Errors, type ReceiptDraft, type ReceiptLineDraft, acceptedOf, toReceiptInput, validateReceipt } from "./validation";

const without = (errors: Errors, field: string): Errors => Object.fromEntries(Object.entries(errors).filter(([key]) => key !== field));

const SMALL_INPUT =
  "h-8 w-full rounded-[3px] border bg-admin-surface px-2 text-right text-[0.8125rem] tabular-nums text-admin-ink focus:border-copper-500";

/**
 * Record a delivery against a PO. Render it only while open: the idempotency
 * key is made once per opening, so a double submit or a retry after a lost
 * answer never adds the stock twice.
 */
export function ReceiveGoodsDialog({
  po,
  onClose,
  onReceived,
}: {
  po: PurchaseOrder;
  onClose: () => void;
  onReceived: (po: PurchaseOrder) => void;
}) {
  const [key] = useState(newKey);
  const [today] = useState(() => todayKey());
  const [draft, setDraft] = useState<ReceiptDraft>(() => ({
    receivedAt: today,
    notes: "",
    allowOverReceipt: false,
    overReceiptReason: "",
    lines: po.items.map<ReceiptLineDraft>((item) => ({
      poItemId: item.id,
      name: item.name,
      outstanding: item.outstandingQty,
      received: "",
      damaged: "",
      rejected: "",
      note: "",
    })),
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const updateLine = (index: number, patch: Partial<ReceiptLineDraft>) => {
    setDraft((current) => ({ ...current, lines: current.lines.map((line, at) => (at === index ? { ...line, ...patch } : line)) }));
    setErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([field]) => !field.startsWith(`items.${index}.`) && field !== "items")),
    );
  };

  const submit = async () => {
    if (submitting) return;
    const found = validateReceipt(draft, today);
    setErrors(found);
    setFormError("");
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      const updated = await receiveGoods(po.id, toReceiptInput(draft, key));
      toast.success("Delivery recorded. Accepted units were added to stock.");
      onReceived(updated);
    } catch (error) {
      const fields = serverFieldErrors(error, { OVER_RECEIPT: "items", PRODUCT_ARCHIVED: "items" });
      setErrors(fields);
      setFormError(problem(error, "The delivery wasn't recorded. Please try again."));
      setSubmitting(false);
    }
  };

  return (
    <Modal open onOpenChange={(open) => !open && !submitting && onClose()} title={`Receive goods for ${po.poNumber}`} className="max-w-4xl">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
        aria-busy={submitting}
      >
        {formError ? (
          <p role="alert" className="rounded-[3px] border border-[#f1c4c4] bg-[#fbeaea] px-3 py-2 text-xs text-[#a12b2b]">
            {formError}
          </p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-xs">
            <thead className="border-b border-admin-border text-admin-muted">
              <tr>
                <th className="py-2 pr-3 font-medium">Product</th>
                <th className="px-2 py-2 text-right font-medium">Outstanding</th>
                <th className="w-24 px-2 py-2 text-right font-medium">Received</th>
                <th className="w-24 px-2 py-2 text-right font-medium">Damaged</th>
                <th className="w-24 px-2 py-2 text-right font-medium">Rejected</th>
                <th className="px-2 py-2 text-right font-medium">Accepted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              {draft.lines.map((line, index) => {
                const lineErrors = ["receivedQty", "damagedQty", "rejectedQty"]
                  .map((field) => errors[`items.${index}.${field}`])
                  .filter(Boolean);
                const field = (name: "received" | "damaged" | "rejected", apiField: string, label: string) => (
                  <input
                    aria-label={`${label} — ${line.name}`}
                    inputMode="numeric"
                    value={line[name]}
                    disabled={submitting}
                    placeholder="0"
                    onChange={(event) => updateLine(index, { [name]: event.target.value })}
                    aria-invalid={errors[`items.${index}.${apiField}`] ? true : undefined}
                    className={cn(SMALL_INPUT, errors[`items.${index}.${apiField}`] ? "border-[#c23434]" : "border-admin-border")}
                  />
                );
                return (
                  <tr key={line.poItemId} className="align-top">
                    <td className="py-2 pr-3">
                      <span className="block font-medium text-admin-ink">{line.name}</span>
                      {lineErrors.length ? (
                        <span role="alert" className="mt-0.5 block text-[0.6875rem] text-[#c23434]">
                          {lineErrors.join(" ")}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-admin-muted">{line.outstanding}</td>
                    <td className="px-2 py-2">{field("received", "receivedQty", "Received")}</td>
                    <td className="px-2 py-2">{field("damaged", "damagedQty", "Damaged")}</td>
                    <td className="px-2 py-2">{field("rejected", "rejectedQty", "Rejected")}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-admin-ink">{acceptedOf(line)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {errors.items ? (
          <p role="alert" className="text-[0.6875rem] text-[#c23434]">
            {errors.items}
          </p>
        ) : null}
        <p className="text-[0.6875rem] text-admin-muted">Accepted = received − damaged − rejected. Only accepted units are added to stock.</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <AdminInput
            label="Received on"
            type="date"
            max={today}
            value={draft.receivedAt}
            disabled={submitting}
            onChange={(event) => {
              setDraft((current) => ({ ...current, receivedAt: event.target.value }));
              setErrors((current) => without(current, "receivedAt"));
            }}
            error={errors.receivedAt}
          />
          <AdminTextarea
            label="Delivery notes"
            rows={2}
            value={draft.notes}
            disabled={submitting}
            onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
            hint="Challan number, vehicle, who checked it."
          />
        </div>

        <div>
          <AdminCheckbox
            label="Allow over-receipt"
            description="Accept more than is outstanding on a line. Needs a reason."
            checked={draft.allowOverReceipt}
            disabled={submitting}
            onChange={(event) => {
              const allowOverReceipt = event.target.checked;
              setDraft((current) => ({ ...current, allowOverReceipt }));
              setErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => !field.endsWith(".receivedQty") && field !== "overReceiptReason")));
            }}
          />
          {draft.allowOverReceipt ? (
            <AdminInput
              label="Reason for over-receipt"
              required
              className="mt-2"
              value={draft.overReceiptReason}
              disabled={submitting}
              onChange={(event) => {
                setDraft((current) => ({ ...current, overReceiptReason: event.target.value }));
                setErrors((current) => without(current, "overReceiptReason"));
              }}
              error={errors.overReceiptReason}
            />
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          <AdminButton variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={submitting}>
            Record delivery
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}
