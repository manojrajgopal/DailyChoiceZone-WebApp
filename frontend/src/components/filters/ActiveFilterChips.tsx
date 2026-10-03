"use client";

import { X } from "lucide-react";

import type { ProductFacets, ProductQuery } from "@/types";

import { formatPrice, humanize } from "@/lib/utils/format";
import {
  toggleAttributeValue,
  toggleFilterValue,
  withAttributeRange,
  withAvailability,
  withInStockOnly,
  withMinDiscount,
  withMinRating,
  withPriceRange,
  type MultiFilterKey,
} from "@/lib/filters/search-params";

interface Chip {
  key: string;
  label: string;
  next: ProductQuery;
}

export interface ActiveFilterChipsProps {
  query: ProductQuery;
  /** The query with one filter removed. */
  onChange: (next: ProductQuery) => void;
  onClearAll: () => void;
  /** For attribute and option labels; codes and values are shown humanised without it. */
  facets?: ProductFacets | null;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/**
 * Removable chips for every applied filter.
 *
 * Worth the code: without them, a shopper who has ticked four boxes across
 * three collapsed accordions has no idea why the grid looks so sparse, and no
 * quick way to undo just one choice.
 */
export function ActiveFilterChips({ query, onChange, onClearAll, facets }: ActiveFilterChipsProps) {
  const chips: Chip[] = [];
  const attributes = new Map((facets?.attributes ?? []).map((attribute) => [attribute.code, attribute]));

  const labelFrom = (key: MultiFilterKey, value: string): string => {
    const list =
      key === "category"
        ? facets?.categories
        : key === "brand"
          ? facets?.brands
          : key === "color"
            ? facets?.colors
            : undefined;
    const match = list?.find((option) => option.value.toLowerCase() === value.toLowerCase());
    return match?.label || humanize(value);
  };

  const addList = (key: MultiFilterKey, prefix?: string) => {
    (query[key] ?? []).forEach((value) => {
      const label = labelFrom(key, value);
      chips.push({
        key: `${key}:${value}`,
        label: prefix ? `${prefix}: ${label}` : label,
        next: toggleFilterValue(query, key, value),
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
    chips.push({ key: "price", label, next: withPriceRange(query, undefined, undefined) });
  }

  if (typeof query.minRating === "number") {
    chips.push({ key: "rating", label: `${query.minRating}★ & above`, next: withMinRating(query, undefined) });
  }

  if (typeof query.minDiscount === "number") {
    chips.push({
      key: "discount",
      label: `${query.minDiscount}% off or more`,
      next: withMinDiscount(query, undefined),
    });
  }

  if (query.availability) {
    chips.push({
      key: "availability",
      label: query.availability === "in-stock" ? "In stock" : "Out of stock",
      next: withAvailability(query, undefined),
    });
  } else if (query.inStockOnly) {
    chips.push({ key: "in-stock", label: "In stock only", next: withInStockOnly(query, false) });
  }

  for (const [code, values] of Object.entries(query.attributes ?? {})) {
    const attribute = attributes.get(code);
    const name = attribute?.label || humanize(code.replace(/_/g, " "));
    values.forEach((value) => {
      const option = attribute?.options.find((entry) => entry.value.toLowerCase() === value.toLowerCase());
      const optionLabel =
        option?.label || (value === "true" ? "Yes" : value === "false" ? "No" : humanize(value));
      chips.push({
        key: `attr:${code}:${value}`,
        label: `${name}: ${optionLabel}`,
        next: toggleAttributeValue(query, code, value),
      });
    });
  }

  for (const [code, range] of Object.entries(query.attributeRanges ?? {})) {
    const lower = typeof range.min === "number" ? range.min : undefined;
    const upper = typeof range.max === "number" ? range.max : undefined;
    if (lower === undefined && upper === undefined) continue;
    const attribute = attributes.get(code);
    const name = attribute?.label || humanize(code.replace(/_/g, " "));
    const unit = attribute?.unit ? ` ${attribute.unit}` : "";
    const span =
      lower !== undefined && upper !== undefined
        ? `${formatNumber(lower)} – ${formatNumber(upper)}${unit}`
        : lower !== undefined
          ? `${formatNumber(lower)}${unit} or more`
          : `up to ${formatNumber(upper ?? 0)}${unit}`;
    chips.push({
      key: `range:${code}`,
      label: `${name}: ${span}`,
      next: withAttributeRange(query, code, undefined, undefined),
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => onChange(chip.next)}
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
