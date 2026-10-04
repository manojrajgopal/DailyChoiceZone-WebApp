"use client";

import { useState } from "react";

import { IdAutocomplete } from "@/components/common/IdAutocomplete";
import { problem } from "@/components/admin/views/operations/shared";
import { cn } from "@/lib/utils/cn";
import type { PickableProduct } from "@/services/admin/growthAdminService";
import { resolveId, type IdPreview } from "@/services/lookupService";

export const rupees = (value: number) =>
  `₹${value.toLocaleString("en-IN", { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** A UTC timestamp as the value a `datetime-local` input shows, in the browser's time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/** A `datetime-local` value back to UTC ISO, which is what the API stores. */
export function fromLocalInput(value: string): string {
  return value ? new Date(value).toISOString() : "";
}

/** The API's naive UTC timestamps as a Date. */
export function utc(iso: string): Date {
  return new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
}

/** The preview's Price (paise) etc. as the product the pickers hand back. */
export function pickableFromPreview(preview: IdPreview): PickableProduct {
  const value = (label: string) => preview.fields.find((f) => f.label === label)?.value;
  const num = (label: string) => Number(value(label) ?? 0) || 0;
  const stock = num("Stock");
  const available = value("Available") === undefined ? stock : num("Available");
  return {
    id: preview.id,
    name: preview.title,
    sku: String(value("SKU") ?? ""),
    price: num("Price") / 100,
    stock,
    reservedStock: Math.max(0, stock - available),
    status: preview.status,
    images: preview.image ? [preview.image] : [],
  };
}

const SELLABLE = new Set(["active", "out-of-stock"]);

/**
 * Add a product to a sale, a bundle or an order by its Product ID or SKU
 * (docs/id-lookup.md) — never by name. The chosen ID's details are read once,
 * exactly; already-chosen products can't be picked again, and a product that
 * isn't on sale (draft, archived) is refused with a reason.
 */
export function ProductPicker({
  chosen,
  onPick,
  label = "Add a product",
}: {
  chosen: string[];
  onPick: (product: PickableProduct) => void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pick = async (id: string, preview?: IdPreview) => {
    setError("");
    setBusy(true);
    try {
      const product = pickableFromPreview(preview ?? (await resolveId("admin", "product", id)));
      if (chosen.includes(product.id)) setError(`${product.id} is already added.`);
      else if (!SELLABLE.has(product.status)) {
        setError(`${product.id} (${product.name}) is ${product.status || "not on sale"} and can't be added.`);
      } else onPick(product);
    } catch (e) {
      setError(problem(e, `Couldn't load Product ID ${id}.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[3px] border border-dashed border-admin-border p-3">
      <IdAutocomplete
        entity="product"
        label={`${label} — Product ID or SKU`}
        placeholder="Search Product ID or SKU…"
        exclude={chosen}
        disabled={busy}
        onSelect={(id, preview) => void pick(id, preview)}
      />
      {busy ? <p className="mt-2 text-xs text-admin-muted">Loading product…</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-[#a32424]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  healthy: "bg-[#e7f5e7] text-[#0a6b0a] ring-[#bfe3bf]",
  degraded: "bg-[#fdf3e3] text-[#8a5a12] ring-[#f2d9a8]",
  unhealthy: "bg-[#fbeaea] text-[#a12b2b] ring-[#f1c4c4]",
  unknown: "bg-admin-raised text-admin-muted ring-admin-border",
};

export function HealthBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-[3px] px-2 py-0.5 text-[0.6875rem] font-medium capitalize ring-1 ring-inset",
      STATUS_TONE[status] ?? STATUS_TONE.unknown, className)}>
      {status}
    </span>
  );
}
