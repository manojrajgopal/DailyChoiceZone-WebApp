"use client";

import { X } from "lucide-react";

import type { ProductQuery } from "@/types";

import { formatPrice, humanize } from "@/lib/utils/format";

import type { MultiFilterKey } from "@/hooks/useProductQuery";

interface Chip {
  label: string;
  onRemove: () => void;
}

export interface ActiveFilterChipsProps {
  query: ProductQuery;
  onToggle: (key: MultiFilterKey, value: string) => void;
  onPriceChange: (min?: number, max?: number) => void;
  onRatingChange: (rating?: number) => void;
  onDiscountChange: (discount?: number) => void;
  onStockChange: (inStockOnly: boolean) => void;
  onClearAll: () => void;
}

/**
 * Removable chips for every applied filter.
 *
 * Worth the code: without them, a shopper who has ticked four boxes across
 * three collapsed accordions has no idea why the grid looks so sparse, and no
 * quick way to undo just one choice.
 */
export function ActiveFilterChips({
  query,
  onToggle,
  onPriceChange,
  onRatingChange,
  onDiscountChange,
  onStockChange,
  onClearAll,
}: ActiveFilterChipsProps) {
  const chips: Chip[] = [];

  const addList = (key: MultiFilterKey, prefix?: string) => {
    (query[key] ?? []).forEach((value) => {
      chips.push({
        label: prefix ? `${prefix}: ${humanize(value)}` : humanize(value),
        onRemove: () => onToggle(key, value),
      });
    });
  };

  addList("category");
  addList("subcategory");
  addList("brand");
  addList("size", "Size");
  addList("color");

  if (typeof query.minPrice === "number" || typeof query.maxPrice === "number") {
    const lower = query.minPrice;
    const upper = query.maxPrice;
    const label =
      typeof lower === "number" && typeof upper === "number"
        ? `${formatPrice(lower)} – ${formatPrice(upper)}`
        : typeof lower === "number"
          ? `Over ${formatPrice(lower)}`
          : `Under ${formatPrice(upper ?? 0)}`;
    chips.push({ label, onRemove: () => onPriceChange(undefined, undefined) });
  }

  if (typeof query.minRating === "number") {
    chips.push({
      label: `${query.minRating}★ & above`,
      onRemove: () => onRatingChange(undefined),
    });
  }

  if (typeof query.minDiscount === "number") {
    chips.push({
      label: `${query.minDiscount}% off or more`,
      onRemove: () => onDiscountChange(undefined),
    });
  }

  if (query.inStockOnly) {
    chips.push({ label: "In stock only", onRemove: () => onStockChange(false) });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip, index) => (
        <button
          key={`${chip.label}-${index}`}
          type="button"
          onClick={chip.onRemove}
          aria-label={`Remove filter: ${chip.label}`}
          className="group inline-flex items-center gap-1.5 rounded-pill border border-ink-200 bg-shell px-3 py-1.5 text-xs text-ink-700 transition-colors hover:border-ink hover:text-ink"
        >
          {chip.label}
          <X
            className="h-3 w-3 text-ink-400 transition-colors group-hover:text-ink"
            strokeWidth={2}
            aria-hidden="true"
          />
        </button>
      ))}

      {chips.length > 1 ? (
        <button
          type="button"
          onClick={onClearAll}
          className="ml-1 border-b border-ink-300 pb-0.5 text-xs text-ink-500 transition-colors hover:border-ink hover:text-ink"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
