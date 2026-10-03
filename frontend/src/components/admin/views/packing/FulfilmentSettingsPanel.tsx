"use client";

import { useState } from "react";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { ApiError } from "@/services/api/client";
import { getFulfilmentSettings, saveFulfilmentSettings } from "@/services/admin/packingAdminService";
import { toast } from "@/store/toastStore";
import type { FulfilmentSettings, PackageType } from "@/types/packing";

type Form = {
  slaHours: string;
  volumetricDivisor: string;
  slipShowPrices: boolean;
  labelFormat: string;
  pkgType: PackageType;
  pkgWeight: string;
  pkgLength: string;
  pkgWidth: string;
  pkgHeight: string;
};

const text = (value: number | null | undefined) => (value == null ? "" : String(value));

function toForm(settings: FulfilmentSettings): Form {
  const pkg = settings.defaultPackage;
  return {
    slaHours: String(settings.slaHours),
    volumetricDivisor: String(settings.volumetricDivisor),
    slipShowPrices: settings.slipShowPrices,
    labelFormat: settings.labelFormat,
    pkgType: pkg?.type ?? "box",
    pkgWeight: text(pkg?.weightGrams),
    pkgLength: text(pkg?.lengthCm),
    pkgWidth: text(pkg?.widthCm),
    pkgHeight: text(pkg?.heightCm),
  };
}

/**
 * Packing and label settings: how long an order may wait before it's
 * overdue, the courier's volumetric divisor, whether packing slips show
 * prices, the default label size and a default package to start new parcels
 * from. The server validates every value and records the change in the audit
 * log.
 */
export function FulfilmentSettingsPanel() {
  const loaded = useAdminResource(() => getFulfilmentSettings(), []);
  // The edits; until the first one, the form shows what was loaded.
  const [draft, setForm] = useState<Form | null>(null);
  const form = draft ?? (loaded.data ? toForm(loaded.data) : null);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [saving, setSaving] = useState(false);

  // Without the settings permission the panel isn't offered.
  if (loaded.error instanceof ApiError && loaded.error.status === 403) return null;
  if (!form || !loaded.data) {
    return (
      <AdminCard title="Packing & labels">
        {loaded.error ? (
          <p role="alert" className="text-xs text-[#a12b2b]">{problem(loaded.error, "These settings didn't load.")}</p>
        ) : (
          <span aria-busy="true" aria-label="Loading packing settings" className="block h-24 animate-pulse rounded-[2px] bg-admin-border" />
        )}
      </AdminCard>
    );
  }

  const set = (patch: Partial<Form>) => setForm((current) => ({ ...(current ?? form), ...patch }));

  const save = async () => {
    const next: typeof errors = {};
    const sla = Number(form.slaHours);
    if (!Number.isInteger(sla) || sla < 1 || sla > 336) next.slaHours = "A whole number of hours, 1 to 336.";
    const divisor = Number(form.volumetricDivisor);
    if (!Number.isInteger(divisor) || divisor < 1000 || divisor > 10000) next.volumetricDivisor = "1000 to 10000 (most couriers use 5000).";
    const pkgFields = [form.pkgWeight, form.pkgLength, form.pkgWidth, form.pkgHeight];
    const anyPkg = pkgFields.some((value) => value.trim() !== "");
    if (anyPkg) {
      const g = Number(form.pkgWeight);
      if (!Number.isInteger(g) || g < 1 || g > 100000) next.pkgWeight = "Whole grams, 1 to 100000.";
      for (const key of ["pkgLength", "pkgWidth", "pkgHeight"] as const) {
        const cm = Number(form[key]);
        if (!(cm > 0 && cm <= 300)) next[key] = "0.1 to 300 cm.";
      }
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      const saved = await saveFulfilmentSettings({
        slaHours: sla,
        volumetricDivisor: divisor,
        slipShowPrices: form.slipShowPrices,
        labelFormat: form.labelFormat,
        defaultPackage: anyPkg ? {
          type: form.pkgType, weightGrams: Number(form.pkgWeight), lengthCm: Number(form.pkgLength),
          widthCm: Number(form.pkgWidth), heightCm: Number(form.pkgHeight),
        } : null,
      });
      setForm(toForm(saved));
      toast.success("Packing settings saved.");
    } catch (error) {
      toast.error(problem(error, "The settings weren't saved. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminCard title="Packing & labels" description="Used by the packing queue, packing slips and the store's shipping labels.">
      <form noValidate onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex flex-col gap-4">
        <FormGrid columns={3}>
          <AdminInput label="Pack within (hours)" inputMode="numeric" value={form.slaHours} error={errors.slaHours}
            hint="Orders waiting longer show as overdue." onChange={(e) => set({ slaHours: e.target.value })} />
          <AdminInput label="Volumetric divisor" inputMode="numeric" value={form.volumetricDivisor}
            error={errors.volumetricDivisor} hint="L × W × H (cm) ÷ this = kg."
            onChange={(e) => set({ volumetricDivisor: e.target.value })} />
          <AdminSelect label="Label size" value={form.labelFormat} onChange={(e) => set({ labelFormat: e.target.value })}
            options={loaded.data.formats.map((f) => ({ value: f.key, label: `${f.name} (${f.widthMm} × ${f.heightMm} mm)` }))} />
        </FormGrid>
        <AdminToggle label="Show prices on packing slips" checked={form.slipShowPrices}
          description="Off suits gifts; staff can still choose per slip."
          onChange={(checked) => set({ slipShowPrices: checked })} />
        <fieldset>
          <legend className="mb-2 text-xs font-medium text-admin-ink">Default package (optional)</legend>
          <FormGrid columns={3}>
            <AdminSelect label="Type" value={form.pkgType} onChange={(e) => set({ pkgType: e.target.value as PackageType })}
              options={loaded.data.packageTypes.map((t) => ({ value: t, label: t[0]!.toUpperCase() + t.slice(1) }))} />
            <AdminInput label="Weight (g)" inputMode="numeric" value={form.pkgWeight} error={errors.pkgWeight}
              onChange={(e) => set({ pkgWeight: e.target.value })} />
            <AdminInput label="Length (cm)" inputMode="decimal" value={form.pkgLength} error={errors.pkgLength}
              onChange={(e) => set({ pkgLength: e.target.value })} />
            <AdminInput label="Width (cm)" inputMode="decimal" value={form.pkgWidth} error={errors.pkgWidth}
              onChange={(e) => set({ pkgWidth: e.target.value })} />
            <AdminInput label="Height (cm)" inputMode="decimal" value={form.pkgHeight} error={errors.pkgHeight}
              onChange={(e) => set({ pkgHeight: e.target.value })} />
          </FormGrid>
          <p className="mt-1 text-[0.6875rem] text-admin-muted">Leave all blank for no default.</p>
        </fieldset>
        <div className="flex justify-end">
          <AdminButton type="submit" variant="primary" loading={saving}>Save packing settings</AdminButton>
        </div>
      </form>
    </AdminCard>
  );
}
