"use client";

import { useState } from "react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea, FormGrid } from "@/components/admin/ui/AdminForm";
import type { DefaultPackage, PackageInput, PackageType, PackageView, PackingLineView } from "@/types/packing";

const TYPE_LABELS: Record<PackageType, string> = {
  box: "Box", envelope: "Envelope", polybag: "Polybag", tube: "Tube", crate: "Crate", other: "Other",
};

function num(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * A package: its type, weight and size, and what goes in it. Quantities start
 * at everything picked that isn't in another package yet; the server checks
 * the same and refuses more.
 */
export function PackageForm({
  lines,
  existing,
  defaults,
  divisor,
  busy,
  onSave,
  onCancel,
}: {
  lines: PackingLineView[];
  existing?: PackageView;
  defaults: DefaultPackage | null;
  divisor: number;
  busy: boolean;
  onSave: (input: PackageInput) => void;
  onCancel: () => void;
}) {
  const start = existing ?? defaults;
  const [type, setType] = useState<PackageType>(start?.type ?? "box");
  const [weight, setWeight] = useState(start?.weightGrams != null ? String(start.weightGrams) : "");
  const [length, setLength] = useState(start?.lengthCm != null ? String(start.lengthCm) : "");
  const [width, setWidth] = useState(start?.widthCm != null ? String(start.widthCm) : "");
  const [height, setHeight] = useState(start?.heightCm != null ? String(start.heightCm) : "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  // Free to pack per line: picked, less what other packages hold (this one's own counts back in).
  const free = (line: PackingLineView) =>
    line.pickedQty - line.allocatedQty + (existing?.items.find((i) => i.lineId === line.id)?.quantity ?? 0);
  const [quantities, setQuantities] = useState<Record<number, string>>(() =>
    Object.fromEntries(lines.map((line) => [line.id, String(existing
      ? existing.items.find((i) => i.lineId === line.id)?.quantity ?? 0
      : Math.max(0, line.pickedQty - line.allocatedQty))])));
  const [errors, setErrors] = useState<Record<string, string>>({});

  const l = num(length), w = num(width), h = num(height);
  const volumetric = l && w && h && divisor ? Math.round(((l * w * h) / divisor) * 100) / 100 : null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const problems: Record<string, string> = {};
    const g = num(weight);
    if (g === null || Number.isNaN(g) || g < 1 || !Number.isInteger(g)) problems.weight = "Enter the weight in whole grams.";
    for (const [key, value] of [["length", l], ["width", w], ["height", h]] as const) {
      if (value === null || Number.isNaN(value) || value <= 0 || value > 300) {
        problems[key] = "Enter a size between 0.1 and 300 cm.";
      }
    }
    const items = lines.map((line) => ({ lineId: line.id, quantity: Number(quantities[line.id] || 0) }));
    for (const line of lines) {
      const q = Number(quantities[line.id] || 0);
      if (!Number.isInteger(q) || q < 0 || q > free(line)) problems[`line-${line.id}`] = `0 to ${Math.max(0, free(line))}.`;
    }
    if (!items.some((item) => item.quantity > 0)) problems.items = "Put at least one item in the package.";
    setErrors(problems);
    if (Object.keys(problems).length) return;
    onSave({ type, weightGrams: g, lengthCm: l, widthCm: w, heightCm: h, notes: notes.trim(),
      items: items.filter((item) => item.quantity > 0) });
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-[3px] border border-admin-border bg-admin-raised p-3"
      aria-label={existing ? `Edit ${existing.packageNumber}` : "New package"}>
      <FormGrid columns={3}>
        <AdminSelect label="Type" value={type} onChange={(event) => setType(event.target.value as PackageType)}
          options={Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
        <AdminInput label="Weight (g)" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)}
          error={errors.weight} required />
        <div className="text-xs text-admin-muted sm:pt-6">
          Volumetric weight: <span className="font-medium text-admin-ink">{volumetric ? `${volumetric} kg` : "—"}</span>
          <span className="block text-[0.625rem]">L × W × H ÷ {divisor}</span>
        </div>
        <AdminInput label="Length (cm)" inputMode="decimal" value={length} onChange={(e) => setLength(e.target.value)}
          error={errors.length} required />
        <AdminInput label="Width (cm)" inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)}
          error={errors.width} required />
        <AdminInput label="Height (cm)" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)}
          error={errors.height} required />
      </FormGrid>

      <fieldset>
        <legend className="mb-1 text-xs font-medium text-admin-ink">In this package</legend>
        <ul className="flex flex-col gap-1">
          {lines.map((line) => (
            <li key={line.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-admin-ink">
                {line.name}
                <span className="text-admin-muted"> · {line.sku}{line.size ? ` · ${line.size}` : ""}{line.color ? ` · ${line.color}` : ""}</span>
              </span>
              <span className="text-admin-muted">up to {Math.max(0, free(line))}</span>
              <input
                aria-label={`Quantity of ${line.name} in this package`}
                inputMode="numeric"
                value={quantities[line.id] ?? "0"}
                onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value.replace(/\D/g, "") }))}
                className="h-8 w-16 rounded-[3px] border border-admin-border px-2 text-right tabular-nums"
              />
              {errors[`line-${line.id}`] ? <span role="alert" className="text-[#c23434]">{errors[`line-${line.id}`]}</span> : null}
            </li>
          ))}
        </ul>
        {errors.items ? <p role="alert" className="mt-1 text-xs text-[#c23434]">{errors.items}</p> : null}
      </fieldset>

      <AdminTextarea label="Notes" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />

      <div className="flex justify-end gap-2">
        <AdminButton onClick={onCancel} disabled={busy}>Cancel</AdminButton>
        <AdminButton type="submit" variant="primary" loading={busy}>{existing ? "Save package" : "Add package"}</AdminButton>
      </div>
    </form>
  );
}
