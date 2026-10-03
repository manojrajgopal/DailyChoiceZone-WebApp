"use client";

import { useState } from "react";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { useAdminResource } from "@/hooks/useAdminResource";
import { ApiError } from "@/services/api/client";
import { getRefundSettings, saveRefundSettings } from "@/services/admin/refundsAdminService";
import { toast } from "@/store/toastStore";
import type { RefundMethod, RefundSettings } from "@/types/refunds";
import { REFUND_METHOD_LABELS } from "@/types/refunds";

type Form = Omit<RefundSettings, "methods" | "approvalThreshold" | "pollMinutes" | "maxAttempts"> & {
  approvalThreshold: string;
  pollMinutes: string;
  maxAttempts: string;
};

function toForm(settings: RefundSettings): Form {
  return {
    ...settings,
    approvalThreshold: String(settings.approvalThreshold),
    pollMinutes: String(settings.pollMinutes),
    maxAttempts: String(settings.maxAttempts),
  };
}

function whole(text: string, low: number, high: number): number | null {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= low && n <= high ? n : null;
}

/**
 * How item-level refunds work: where money may go back, the amount above
 * which a manager must approve, what returns and cash-on-delivery orders
 * default to, and how the gateway is followed up. Only staff with the
 * large-refunds permission can change it; the server checks that and audits
 * the change.
 */
export function RefundSettingsPanel() {
  const loaded = useAdminResource(() => getRefundSettings(), []);
  const [draft, setDraft] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [saving, setSaving] = useState(false);
  const form = draft ?? (loaded.data ? toForm(loaded.data) : null);

  if (loaded.error instanceof ApiError && loaded.error.status === 403) return null;
  if (!form || !loaded.data) {
    return (
      <AdminCard title="Item refunds">
        {loaded.error ? (
          <p role="alert" className="text-xs text-[#a12b2b]">These settings didn&rsquo;t load.</p>
        ) : (
          <span aria-busy="true" aria-label="Loading refund rules" className="block h-24 animate-pulse rounded-[2px] bg-admin-border" />
        )}
      </AdminCard>
    );
  }

  const methods = loaded.data.methods;
  const set = (patch: Partial<Form>) => setDraft({ ...form, ...patch });
  const methodOptions = form.allowedMethods.map((value) => ({ value, label: REFUND_METHOD_LABELS[value] ?? value }));

  const toggleMethod = (method: RefundMethod, on: boolean) => {
    const allowed = on ? [...form.allowedMethods, method] : form.allowedMethods.filter((value) => value !== method);
    const fallback = allowed[0] ?? form.returnsMethod;
    set({
      allowedMethods: methods.filter((value) => allowed.includes(value)),
      returnsMethod: allowed.includes(form.returnsMethod) ? form.returnsMethod : fallback,
      codMethod: allowed.includes(form.codMethod) ? form.codMethod : fallback,
    });
  };

  const save = async () => {
    const next: typeof errors = {};
    const threshold = whole(form.approvalThreshold, 0, 10_000_000);
    const poll = whole(form.pollMinutes, 5, 1440);
    const attempts = whole(form.maxAttempts, 1, 10);
    if (threshold === null) next.approvalThreshold = "Whole rupees, 0 for no approval step.";
    if (poll === null) next.pollMinutes = "5 to 1440 minutes.";
    if (attempts === null) next.maxAttempts = "1 to 10.";
    if (form.allowedMethods.length === 0) next.allowedMethods = "Allow at least one way to refund.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      const saved = await saveRefundSettings({
        allowedMethods: form.allowedMethods, approvalThreshold: threshold!, returnsSkipApproval: form.returnsSkipApproval,
        returnsMethod: form.returnsMethod, codMethod: form.codMethod,
        includeShippingOnFullRefund: form.includeShippingOnFullRefund, autoCreditNote: form.autoCreditNote,
        pollMinutes: poll!, maxAttempts: attempts!,
      });
      setDraft(toForm(saved));
      toast.success("Refund rules saved.");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "The refund rules weren't saved. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminCard title="Item refunds" description="Used when refunding chosen items, quantities and delivery from an order.">
      <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex flex-col gap-4">
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-admin-ink">Refunds can go back to</legend>
          <div className="flex flex-wrap gap-4">
            {methods.map((method) => (
              <AdminCheckbox key={method} label={REFUND_METHOD_LABELS[method] ?? method}
                checked={form.allowedMethods.includes(method)}
                onChange={(event) => toggleMethod(method, event.target.checked)} />
            ))}
          </div>
          {errors.allowedMethods ? <p role="alert" className="mt-1 text-xs text-[#c23434]">{errors.allowedMethods}</p> : null}
        </fieldset>
        <FormGrid columns={3}>
          <AdminInput label="Approval needed above (₹)" inputMode="numeric" value={form.approvalThreshold}
            error={errors.approvalThreshold} hint="0: no approval step."
            onChange={(event) => set({ approvalThreshold: event.target.value })} />
          <AdminSelect label="Returns refund to" value={form.returnsMethod} options={methodOptions}
            onChange={(event) => set({ returnsMethod: event.target.value as RefundMethod })} />
          <AdminSelect label="Cash on delivery refunds to" value={form.codMethod} options={methodOptions}
            onChange={(event) => set({ codMethod: event.target.value as RefundMethod })} />
          <AdminInput label="Check the gateway every (minutes)" inputMode="numeric" value={form.pollMinutes}
            error={errors.pollMinutes} onChange={(event) => set({ pollMinutes: event.target.value })} />
          <AdminInput label="Attempts before giving up" inputMode="numeric" value={form.maxAttempts}
            error={errors.maxAttempts} onChange={(event) => set({ maxAttempts: event.target.value })} />
        </FormGrid>
        <div>
          <AdminToggle label="Approved returns skip refund approval" checked={form.returnsSkipApproval}
            description="The return's own approval counts." onChange={(checked) => set({ returnsSkipApproval: checked })} />
          <AdminToggle label="Suggest refunding delivery when every item is refunded"
            checked={form.includeShippingOnFullRefund}
            onChange={(checked) => set({ includeShippingOnFullRefund: checked })} />
          <AdminToggle label="Issue a credit note when a refund completes" checked={form.autoCreditNote}
            onChange={(checked) => set({ autoCreditNote: checked })} />
        </div>
        <div className="flex justify-end">
          <AdminButton type="submit" variant="primary" loading={saving}>Save refund rules</AdminButton>
        </div>
      </form>
    </AdminCard>
  );
}
