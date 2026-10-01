"use client";

import Link from "next/link";
import { Layers, Trash2 } from "lucide-react";

import { ProductImage } from "@/components/common/ProductImage";
import { QuantityStepper } from "@/components/common/VariantPickers";
import { Badge } from "@/components/ui/Badge";
import { formatMoney } from "@/lib/money";
import type { CartBundleLine } from "@/services/growthService";

/**
 * A bundle in the bag: one price for the set, with what's inside and the
 * size and colour chosen for each. Priced by the server.
 */
export function CartBundleRow({
  bundle,
  onQuantityChange,
  onRemove,
}: {
  bundle: CartBundleLine;
  onQuantityChange: (entryId: number, quantity: number) => void;
  onRemove: (entryId: number, name: string) => void;
}) {
  const saving = bundle.regularUnitPrice - bundle.unitPrice;
  return (
    <li className="flex gap-4 py-5">
      <Link href={`/bundles/${bundle.slug}`} className="shrink-0" aria-label={bundle.name} tabIndex={-1}>
        <ProductImage src={bundle.image} alt="" sizes="112px" wrapperClassName="h-32 w-24 rounded-card sm:h-36 sm:w-28" />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="label-wide inline-flex items-center gap-1.5 text-copper-700">
              <Layers className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" /> Bundle
            </p>
            <h3 className="mt-1 text-[0.9375rem] leading-snug text-ink">
              <Link href={`/bundles/${bundle.slug}`} className="transition-colors hover:text-copper-700">{bundle.name}</Link>
            </h3>
            <ul className="mt-2 flex flex-col gap-0.5 text-xs text-ink-500">
              {bundle.components.map((c) => (
                <li key={c.productId}>
                  {c.quantity > 1 ? `${c.quantity} × ` : ""}{c.name}
                  {c.size ? ` · ${c.size}` : ""}{c.color ? ` · ${c.color}` : ""}
                </li>
              ))}
            </ul>
            {bundle.problem ? <Badge tone="soldout" className="mt-2">{bundle.problem}</Badge>
              : saving > 0 ? <Badge tone="sale" className="mt-2">You save {formatMoney(saving * bundle.quantity)}</Badge> : null}
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[0.9375rem] font-medium text-ink tabular-nums">{formatMoney(bundle.lineTotal)}</p>
            {saving > 0 ? <p className="text-xs text-ink-400 line-through tabular-nums">{formatMoney(bundle.regularUnitPrice * bundle.quantity)}</p> : null}
            {bundle.quantity > 1 ? <p className="mt-1 text-xs text-ink-400 tabular-nums">{formatMoney(bundle.unitPrice)} each</p> : null}
          </div>
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4">
          <QuantityStepper value={bundle.quantity} onChange={(q) => onQuantityChange(bundle.id, q)}
            max={Math.max(1, Math.min(bundle.maxPerOrder, bundle.available))} size="sm" />
          <button type="button" onClick={() => onRemove(bundle.id, bundle.name)}
            className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-xs text-ink-500 transition-colors hover:bg-danger-bg hover:text-danger">
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" /> Remove
          </button>
        </div>
      </div>
    </li>
  );
}
