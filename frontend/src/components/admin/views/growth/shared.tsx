"use client";

import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { problem } from "@/components/admin/views/operations/shared";
import { cn } from "@/lib/utils/cn";
import { type PickableProduct, searchProducts } from "@/services/admin/growthAdminService";

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

/**
 * Find a product to add to a sale or a bundle, with the portal's own product
 * search. Already-chosen products are shown but can't be added twice.
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
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickableProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      setBusy(true);
      searchProducts(q.trim())
        .then((rows) => live && (setResults(rows), setError("")))
        .catch((e) => live && setError(problem(e, "Search didn't work.")))
        .finally(() => live && setBusy(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  return (
    <div className="rounded-[3px] border border-dashed border-admin-border p-3">
      <label className="flex items-center gap-2 text-xs text-admin-muted">
        <Search className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        <span className="sr-only">{label}</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`${label}: search by name or SKU`}
          className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] text-admin-ink outline-none focus:border-copper-500"
        />
      </label>
      {error ? <p className="mt-2 text-xs text-[#a32424]">{error}</p> : null}
      {busy ? <p className="mt-2 text-xs text-admin-muted">Searching…</p> : null}
      {results.length ? (
        <ul className="mt-2 max-h-56 divide-y divide-admin-border overflow-y-auto">
          {results.map((product) => {
            const taken = chosen.includes(product.id);
            const sellable = product.status === "active" || product.status === "out-of-stock";
            return (
              <li key={product.id} className="flex items-center justify-between gap-3 py-2 text-xs">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-admin-ink">{product.name}</span>
                  <span className="text-admin-muted">
                    {product.sku} · {rupees(product.price)} · {Math.max(0, product.stock - product.reservedStock)} available
                    {sellable ? "" : ` · ${product.status}`}
                  </span>
                </span>
                <AdminButton size="sm" variant="ghost" disabled={taken || !sellable} onClick={() => onPick(product)}>
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> {taken ? "Added" : "Add"}
                </AdminButton>
              </li>
            );
          })}
        </ul>
      ) : q.trim().length >= 2 && !busy && !error ? (
        <p className="mt-2 text-xs text-admin-muted">No products match.</p>
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
