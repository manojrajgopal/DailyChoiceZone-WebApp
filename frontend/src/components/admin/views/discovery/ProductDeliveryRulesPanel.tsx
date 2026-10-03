"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminToggle, FormGrid, FormSection } from "@/components/admin/ui/AdminForm";
import { useAdminResource } from "@/hooks/useAdminResource";
import { ApiError } from "@/services/api/client";
import {
  getProductDeliveryRules,
  saveProductDeliveryRules,
  type DeliveryExclusion,
  type ProductDeliveryRules,
} from "@/services/admin/discoveryAdminService";
import { toast } from "@/store/toastStore";

const KINDS = [
  { value: "pincode", label: "One pincode" },
  { value: "prefix", label: "Pincodes starting with" },
  { value: "state", label: "A state" },
];

/**
 * A product's own delivery rules, on its edit page.
 *
 * They only ever take away from what the pincode list allows: no cash on
 * delivery for this item, no express (oversized, fragile), handling days before
 * it ships (made to order), and places it isn't sent to. Checked on the
 * product page and again, authoritatively, when an order is placed.
 */
export function ProductDeliveryRulesPanel({ productId }: { productId: string }) {
  const rules = useAdminResource(() => getProductDeliveryRules(productId), [productId], {
    enabled: Boolean(productId),
  });
  const [draft, setDraft] = useState<ProductDeliveryRules | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (rules.data) setDraft(rules.data);
  }, [rules.data]);

  const forbidden = rules.error instanceof ApiError && rules.error.status === 403;
  const set = <K extends keyof ProductDeliveryRules>(key: K, value: ProductDeliveryRules[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  const setExclusion = (index: number, patch: Partial<DeliveryExclusion>) =>
    set("exclusions", (draft?.exclusions ?? []).map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const saved = await saveProductDeliveryRules(productId, {
        codAllowed: draft.codAllowed,
        expressAllowed: draft.expressAllowed,
        dispatchDays: draft.dispatchDays,
        note: draft.note,
        exclusions: draft.exclusions.filter((row) => row.value.trim()),
      });
      setDraft(saved);
      toast.success("Delivery rules saved.");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "The delivery rules didn't save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormSection
      title="Delivery rules"
      description="Only for products that need them. These narrow what the pincode list allows; they never widen it."
    >
      {forbidden ? (
        <p className="text-xs text-admin-muted">Your role doesn&rsquo;t include delivery settings.</p>
      ) : rules.error && !draft ? (
        <div role="alert" className="text-xs text-admin-ink">
          The delivery rules didn&rsquo;t load.
          <AdminButton size="sm" className="ml-2" onClick={() => void rules.reload()}>Try again</AdminButton>
        </div>
      ) : !draft ? (
        <span aria-busy="true" aria-label="Loading delivery rules" className="block h-24 w-full animate-pulse rounded-[2px] bg-admin-border" />
      ) : (
        <div className="flex flex-col gap-3">
          <AdminToggle
            label="Cash on delivery"
            description="Off for high-value items you'd rather have paid for in advance."
            checked={draft.codAllowed}
            onChange={(value) => set("codAllowed", value)}
          />
          <AdminToggle
            label="Express delivery"
            description="Off for oversized or fragile items couriers can't rush."
            checked={draft.expressAllowed}
            onChange={(value) => set("expressAllowed", value)}
          />
          <FormGrid>
            <AdminInput
              label="Handling days"
              type="number"
              min={0}
              max={60}
              value={draft.dispatchDays ?? ""}
              onChange={(event) => set("dispatchDays", event.target.value === "" ? null : Number(event.target.value))}
              hint="Working days to get it ready, before the store's usual dispatch. Empty for none."
            />
            <AdminInput
              label="Note shown to shoppers"
              value={draft.note}
              maxLength={255}
              onChange={(event) => set("note", event.target.value)}
              hint="e.g. “Fragile — not shipped to remote areas”."
            />
          </FormGrid>

          <div>
            <p className="text-xs font-medium text-admin-ink">Not delivered to</p>
            {draft.exclusions.length === 0 ? (
              <p className="mt-1 text-xs text-admin-muted">Anywhere the pincode list allows.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {draft.exclusions.map((row, index) => (
                  <li key={row.id ?? `new-${index}`} className="grid gap-2 sm:grid-cols-[11rem_1fr_1fr_auto] sm:items-end">
                    <AdminSelect
                      label="Where"
                      value={row.kind}
                      options={KINDS}
                      onChange={(event) => setExclusion(index, { kind: event.target.value as DeliveryExclusion["kind"] })}
                    />
                    <AdminInput
                      label={row.kind === "state" ? "State" : row.kind === "prefix" ? "Starts with" : "Pincode"}
                      value={row.value}
                      inputMode={row.kind === "state" ? "text" : "numeric"}
                      maxLength={row.kind === "state" ? 120 : row.kind === "prefix" ? 5 : 6}
                      onChange={(event) => setExclusion(index, { value: event.target.value })}
                    />
                    <AdminInput
                      label="Reason (optional)"
                      value={row.reason}
                      maxLength={255}
                      onChange={(event) => setExclusion(index, { reason: event.target.value })}
                    />
                    <AdminButton
                      size="sm"
                      variant="ghost"
                      aria-label="Remove this place"
                      onClick={() => set("exclusions", draft.exclusions.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </AdminButton>
                  </li>
                ))}
              </ul>
            )}
            <AdminButton
              size="sm"
              className="mt-2"
              onClick={() => set("exclusions", [...draft.exclusions, { kind: "pincode", value: "", reason: "" }])}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add a place
            </AdminButton>
          </div>

          <div className="flex justify-end">
            <AdminButton variant="primary" loading={saving} onClick={() => void save()}>
              Save delivery rules
            </AdminButton>
          </div>
        </div>
      )}
    </FormSection>
  );
}
