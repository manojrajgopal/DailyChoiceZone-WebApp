"use client";

import Link from "next/link";
import { useState } from "react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { problem } from "@/components/admin/views/operations/shared";
import { CRUMBS, TryOnTabs } from "@/components/admin/views/tryon/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import {
  type PlanEntitlement,
  type TryOnRules,
  listCapabilities,
  listModels,
  listPlanEntitlements,
  savePlanEntitlement,
} from "@/services/admin/tryOnAdminService";
import { toast } from "@/store/toastStore";

/**
 * Which membership plans include virtual try-on, and how much. A plan's
 * entitlement is copied onto memberships bought from it; members who bought
 * before the plan included try-on get the plan's current entitlement.
 */
export function AdminTryOnPlansView() {
  const plans = useAdminResource(listPlanEntitlements, []);
  const capabilities = useAdminResource(listCapabilities, []);
  const models = useAdminResource(listModels, []);
  const tiers = [...new Set((models.data ?? []).map((m) => m.qualityTier))];

  return (
    <div>
      <AdminPageHeader title="Plan entitlements" description="What each membership plan includes. Limits are enforced by the server; only successful try-ons count."
        breadcrumbs={[...CRUMBS, { label: "Plan entitlements" }]} />
      <TryOnTabs />
      {plans.error && !plans.data ? <AdminCard><p className="text-sm">{problem(plans.error, "Plans didn't load.")}</p></AdminCard> : null}
      {plans.data && plans.data.plans.length === 0 ? (
        <AdminCard><p className="text-sm text-admin-muted">No membership plans yet. <Link href="/admin/membership" className="text-copper-700 hover:underline">Create one</Link> first.</p></AdminCard>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {plans.data?.plans.map((plan) => (
          <PlanCard key={plan.id} plan={plan} defaults={plans.data!.defaults} capabilities={(capabilities.data ?? []).map((c) => ({ value: c.key, label: c.name }))}
            tiers={tiers} onSaved={() => void plans.reload()} />
        ))}
      </div>
      {plans.data ? (
        <p className="mt-4 text-xs text-admin-muted">
          Non-members: the free trial is {plans.data.trial.enabled ? `on (${plans.data.trial.generations} try-ons)` : "off"} —{" "}
          <Link href="/admin/try-on/settings" className="text-copper-700 hover:underline">change it in settings</Link>.
        </p>
      ) : null}
    </div>
  );
}

function PlanCard({ plan, defaults, capabilities, tiers, onSaved }: {
  plan: PlanEntitlement; defaults: TryOnRules; capabilities: { value: string; label: string }[]; tiers: string[]; onSaved: () => void;
}) {
  const [rules, setRules] = useState<TryOnRules>(plan.tryOn ?? { ...defaults, enabled: false });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<TryOnRules>) => setRules((r) => ({ ...r, ...patch }));
  const toggleList = (key: "capabilities" | "qualityTiers", value: string, on: boolean) =>
    set({ [key]: on ? [...rules[key], value] : rules[key].filter((v) => v !== value) } as Partial<TryOnRules>);
  const num = (value: string) => (value === "" ? null : Number(value));

  return (
    <AdminCard title={plan.name} description={`${plan.durationMonths} month${plan.durationMonths === 1 ? "" : "s"}${plan.active ? "" : " · retired"}`}
      action={<StatusBadge tone={rules.enabled ? "good" : "neutral"}>{rules.enabled ? "Includes try-on" : "No try-on"}</StatusBadge>}>
      <form className="flex flex-col gap-4" onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        void savePlanEntitlement(plan.id, rules).then(() => { toast.success(`${plan.name} saved.`); onSaved(); }, (e) => toast.error(problem(e, "Not saved."))).finally(() => setSaving(false));
      }}>
        <AdminToggle label="Include virtual try-on" checked={rules.enabled} onChange={(enabled) => set({ enabled })} />
        {rules.enabled ? (
          <>
            <FormGrid columns={3}>
              <AdminInput label="Per membership month" type="number" min={1} value={rules.perPeriod ?? ""} onChange={(e) => set({ perPeriod: num(e.target.value) })} hint="Empty: unlimited." />
              <AdminInput label="Per day" type="number" min={1} value={rules.perDay ?? ""} onChange={(e) => set({ perDay: num(e.target.value) })} hint="Empty: no daily cap." />
              <AdminInput label="At once" type="number" min={1} max={10} value={rules.concurrent} onChange={(e) => set({ concurrent: Number(e.target.value) || 1 })} />
              <AdminSelect label="Results are kept" value={rules.retention} onChange={(e) => set({ retention: e.target.value as TryOnRules["retention"] })}
                options={[{ value: "temporary", label: "For a while" }, { value: "permanent", label: "Until deleted" }]} hint="Needs S3; otherwise nothing is kept." />
              {rules.retention === "temporary" ? (
                <AdminInput label="Days kept" type="number" min={1} max={365} value={rules.retentionDays} onChange={(e) => set({ retentionDays: Number(e.target.value) || 7 })} />
              ) : (
                <AdminInput label="Most saved results" type="number" min={1} value={rules.storageQuota ?? ""} onChange={(e) => set({ storageQuota: num(e.target.value) })} hint="Empty: no limit." />
              )}
              <AdminInput label="Largest photo (MB)" type="number" min={0.5} max={25} step="0.5" value={rules.maxUploadMb} onChange={(e) => set({ maxUploadMb: Number(e.target.value) || 8 })} />
              <AdminInput label="Retries per try-on" type="number" min={0} max={10} value={rules.retriesPerRequest} onChange={(e) => set({ retriesPerRequest: Number(e.target.value) })} />
            </FormGrid>
            <fieldset className="text-xs">
              <legend className="mb-1 font-medium text-admin-ink">Kinds of item</legend>
              <p className="mb-1.5 text-admin-muted">None ticked: every available kind.</p>
              <div className="flex flex-wrap gap-x-4">
                {capabilities.map((c) => <AdminCheckbox key={c.value} label={c.label} checked={rules.capabilities.includes(c.value)} onChange={(e) => toggleList("capabilities", c.value, e.target.checked)} />)}
              </div>
            </fieldset>
            {tiers.length > 1 ? (
              <fieldset className="text-xs">
                <legend className="mb-1 font-medium text-admin-ink">Quality levels</legend>
                <div className="flex flex-wrap gap-x-4">
                  {tiers.map((t) => <AdminCheckbox key={t} label={t} checked={rules.qualityTiers.includes(t)} onChange={(e) => toggleList("qualityTiers", t, e.target.checked)} />)}
                </div>
              </fieldset>
            ) : null}
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <AdminToggle label="Download results" checked={rules.download} onChange={(download) => set({ download })} />
              <AdminToggle label="Choose quality" checked={rules.modelChoice} onChange={(modelChoice) => set({ modelChoice })} />
              <AdminToggle label="Ask for more access" checked={rules.allocationRequests} onChange={(allocationRequests) => set({ allocationRequests })} />
            </div>
          </>
        ) : null}
        <AdminButton type="submit" variant="primary" loading={saving} className="self-end">Save</AdminButton>
      </form>
    </AdminCard>
  );
}
