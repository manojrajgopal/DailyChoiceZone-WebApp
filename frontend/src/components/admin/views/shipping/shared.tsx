"use client";

import { AdminInput, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge, type Tone } from "@/components/admin/ui/StatusBadge";
import type { PackageInput, ShipmentAddress, ShipmentPackage, ShipmentStatus } from "@/types/shipping";
import { shipmentStatusLabel } from "@/types/shipping";

/* ------------------------------------------------------------------ badges */

const TONES: Record<ShipmentStatus, Tone> = {
  pending: "warning",
  "ready-for-pickup": "info",
  "pickup-scheduled": "info",
  "picked-up": "info",
  "in-transit": "info",
  "at-destination-hub": "info",
  "out-for-delivery": "info",
  delivered: "good",
  "delivery-attempted": "warning",
  "delivery-failed": "critical",
  "returned-to-origin": "serious",
  cancelled: "neutral",
};

export function ShipmentStatusBadge({ status, label }: { status: string; label?: string | null }) {
  return <StatusBadge tone={TONES[status as ShipmentStatus] ?? "neutral"}>{shipmentStatusLabel(status, label)}</StatusBadge>;
}

/** "2–4 days", "3 days", or "". */
export function formatEta(eta: number | { min: number; max: number } | null | undefined): string {
  if (eta === null || eta === undefined) return "";
  if (typeof eta === "number") return `${eta} ${eta === 1 ? "day" : "days"}`;
  if (eta.min === eta.max) return `${eta.min} ${eta.min === 1 ? "day" : "days"}`;
  return `${eta.min}–${eta.max} days`;
}

/** One line of an address, skipping what's blank. */
export function addressLines(address: ShipmentAddress | null | undefined): string[] {
  if (!address) return [];
  const street = [address.line1, address.line2].filter(Boolean).join(", ");
  const place = [address.city, address.state].filter(Boolean).join(", ");
  return [address.name, street, [place, address.pincode].filter(Boolean).join(" "), address.phone].filter(
    (line): line is string => Boolean(line && line.trim()),
  );
}

/* ----------------------------------------------------------- package form */

export interface PackageForm {
  weightGrams: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  count: string;
  type: string;
}

export const EMPTY_PACKAGE: PackageForm = { weightGrams: "", lengthCm: "", widthCm: "", heightCm: "", count: "", type: "" };

/** Prefill from what the server holds — nothing is made up for a blank field. */
export function packageForm(source: Partial<ShipmentPackage> | null | undefined): PackageForm {
  const text = (value: number | string | null | undefined) => (value === null || value === undefined ? "" : String(value));
  return {
    weightGrams: text(source?.weightGrams),
    lengthCm: text(source?.lengthCm),
    widthCm: text(source?.widthCm),
    heightCm: text(source?.heightCm),
    count: text(source?.count),
    type: text(source?.type),
  };
}

/** Sanity limits for what a person types. The server has the final word. */
export const PACKAGE_LIMITS = {
  weightGrams: { min: 1, max: 100_000 },
  dimensionCm: { min: 0.1, max: 300 },
  count: { min: 1, max: 100 },
  typeLength: 40,
} as const;

export type PackageErrors = Partial<Record<keyof PackageForm, string>>;

/**
 * Check a package. `requireAll` is for API couriers, which need every
 * dimension; Manual needs only the weight. Blank optional fields are left
 * out of the result rather than sent as zero.
 */
export function validatePackage(
  form: PackageForm,
  { requireAll }: { requireAll: boolean },
): { errors: PackageErrors; value: PackageInput } {
  const errors: PackageErrors = {};
  const value: PackageInput = {};

  const weight = form.weightGrams.trim();
  if (!weight) errors.weightGrams = "Enter the weight in grams.";
  else if (!/^\d+$/.test(weight)) errors.weightGrams = "Use whole grams, e.g. 800.";
  else {
    const grams = Number(weight);
    const { min, max } = PACKAGE_LIMITS.weightGrams;
    if (grams < min || grams > max) errors.weightGrams = `Between ${min} and ${max.toLocaleString("en-IN")} grams.`;
    else value.weightGrams = grams;
  }

  for (const key of ["lengthCm", "widthCm", "heightCm"] as const) {
    const raw = form[key].trim();
    if (!raw) {
      if (requireAll) errors[key] = "Required for this courier.";
      continue;
    }
    const number = Number(raw);
    const { min, max } = PACKAGE_LIMITS.dimensionCm;
    if (!/^\d+(\.\d+)?$/.test(raw) || Number.isNaN(number)) errors[key] = "Enter a number of centimetres.";
    else if (number < min || number > max) errors[key] = `Between ${min} and ${max} cm.`;
    else value[key] = number;
  }

  const count = form.count.trim();
  if (!count) {
    if (requireAll) errors.count = "Required for this courier.";
  } else if (!/^\d+$/.test(count)) errors.count = "Use a whole number.";
  else {
    const boxes = Number(count);
    const { min, max } = PACKAGE_LIMITS.count;
    if (boxes < min || boxes > max) errors.count = `Between ${min} and ${max}.`;
    else value.count = boxes;
  }

  const type = form.type.trim();
  if (!type) {
    if (requireAll) errors.type = "Required for this courier.";
  } else if (type.length > PACKAGE_LIMITS.typeLength) errors.type = `At most ${PACKAGE_LIMITS.typeLength} characters.`;
  else value.type = type;

  return { errors, value };
}

export function PackageFields({
  form,
  errors,
  onChange,
  requireAll,
  disabled,
}: {
  form: PackageForm;
  errors: PackageErrors;
  onChange: (patch: Partial<PackageForm>) => void;
  requireAll: boolean;
  disabled?: boolean;
}) {
  return (
    <FormGrid columns={3}>
      <AdminInput
        label="Weight (grams)"
        inputMode="numeric"
        required
        value={form.weightGrams}
        error={errors.weightGrams}
        disabled={disabled}
        onChange={(event) => onChange({ weightGrams: event.target.value })}
      />
      <AdminInput
        label="Length (cm)"
        inputMode="decimal"
        required={requireAll}
        value={form.lengthCm}
        error={errors.lengthCm}
        disabled={disabled}
        onChange={(event) => onChange({ lengthCm: event.target.value })}
      />
      <AdminInput
        label="Width (cm)"
        inputMode="decimal"
        required={requireAll}
        value={form.widthCm}
        error={errors.widthCm}
        disabled={disabled}
        onChange={(event) => onChange({ widthCm: event.target.value })}
      />
      <AdminInput
        label="Height (cm)"
        inputMode="decimal"
        required={requireAll}
        value={form.heightCm}
        error={errors.heightCm}
        disabled={disabled}
        onChange={(event) => onChange({ heightCm: event.target.value })}
      />
      <AdminInput
        label="Number of packages"
        inputMode="numeric"
        required={requireAll}
        value={form.count}
        error={errors.count}
        disabled={disabled}
        onChange={(event) => onChange({ count: event.target.value })}
      />
      <AdminInput
        label="Package type"
        placeholder="e.g. box"
        required={requireAll}
        value={form.type}
        error={errors.type}
        disabled={disabled}
        maxLength={PACKAGE_LIMITS.typeLength + 10}
        onChange={(event) => onChange({ type: event.target.value })}
      />
    </FormGrid>
  );
}
