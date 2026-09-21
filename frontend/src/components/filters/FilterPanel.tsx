"use client";

import { useState } from "react";
import { Star } from "lucide-react";

import type { ProductFacets, ProductQuery } from "@/types";

import { Accordion } from "@/components/ui/Accordion";
import { Checkbox } from "@/components/ui/Field";
import { cn } from "@/lib/utils/cn";
import { formatPrice, humanize } from "@/lib/utils/format";

import type { MultiFilterKey } from "@/hooks/useProductQuery";

export interface FilterPanelProps {
  facets: ProductFacets;
  query: ProductQuery;
  onToggle: (key: MultiFilterKey, value: string) => void;
  onPriceChange: (min?: number, max?: number) => void;
  onRatingChange: (rating?: number) => void;
  onDiscountChange: (discount?: number) => void;
  onStockChange: (inStockOnly: boolean) => void;
  /** Hidden on a category page, where the category is already fixed. */
  showCategoryFilter?: boolean;
  className?: string;
}

const RATINGS = [4, 3, 2] as const;
const DISCOUNTS = [10, 25, 40, 50] as const;

/**
 * The filter panel.
 *
 * One component serves the desktop sidebar and the mobile bottom sheet — the
 * sheet simply renders this inside a drawer. Options and their counts come
 * from facets computed over the current scope, so a category page never offers
 * a brand that has nothing in it.
 */
export function FilterPanel({
  facets,
  query,
  onToggle,
  onPriceChange,
  onRatingChange,
  onDiscountChange,
  onStockChange,
  showCategoryFilter = true,
  className,
}: FilterPanelProps) {
  const isChecked = (key: MultiFilterKey, value: string) =>
    (query[key] ?? []).some((entry) => entry.toLowerCase() === value.toLowerCase());

  const countFor = (key: MultiFilterKey) => (query[key] ?? []).length;

  return (
    <div className={cn("flex flex-col", className)}>
      {showCategoryFilter && facets.categories.length > 1 ? (
        <Accordion
          title="Category"
          defaultOpen
          meta={<ActiveCount value={countFor("category")} />}
        >
          <div className="flex flex-col">
            {facets.categories.map((option) => (
              <Checkbox
                key={option.value}
                label={option.label}
                count={option.count}
                checked={isChecked("category", option.value)}
                onChange={() => onToggle("category", option.value)}
              />
            ))}
          </div>
        </Accordion>
      ) : null}

      {facets.subcategories.length > 1 ? (
        <Accordion
          title="Product type"
          defaultOpen
          meta={<ActiveCount value={countFor("subcategory")} />}
        >
          <div className="flex max-h-64 flex-col overflow-y-auto pr-1">
            {facets.subcategories.map((option) => (
              <Checkbox
                key={option.value}
                label={humanize(option.value)}
                count={option.count}
                checked={isChecked("subcategory", option.value)}
                onChange={() => onToggle("subcategory", option.value)}
              />
            ))}
          </div>
        </Accordion>
      ) : null}

      <PriceFilter
        // Remount whenever the committed range changes, so the inputs reseed.
        key={`${query.minPrice ?? ""}-${query.maxPrice ?? ""}`}
        min={facets.priceRange.min}
        max={facets.priceRange.max}
        value={[query.minPrice, query.maxPrice]}
        onChange={onPriceChange}
      />

      {facets.sizes.length > 0 ? (
        <Accordion title="Size" meta={<ActiveCount value={countFor("size")} />}>
          <div className="flex flex-wrap gap-2 pt-1">
            {facets.sizes.map((option) => {
              const active = isChecked("size", option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onToggle("size", option.value)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex h-9 min-w-[2.75rem] items-center justify-center rounded-control border px-3 text-xs transition-colors",
                    active
                      ? "border-ink bg-ink text-cream"
                      : "border-ink-200 bg-shell text-ink hover:border-ink",
                  )}
                >
                  {option.value}
                </button>
              );
            })}
          </div>
        </Accordion>
      ) : null}

      {facets.colors.length > 0 ? (
        <Accordion title="Colour" meta={<ActiveCount value={countFor("color")} />}>
          <div className="flex max-h-64 flex-col overflow-y-auto pr-1">
            {facets.colors.map((option) => (
              <Checkbox
                key={option.value}
                label={option.label}
                count={option.count}
                checked={isChecked("color", option.value)}
                onChange={() => onToggle("color", option.value)}
              />
            ))}
          </div>
        </Accordion>
      ) : null}

      {facets.brands.length > 1 ? (
        <Accordion title="Brand" meta={<ActiveCount value={countFor("brand")} />}>
          <div className="flex max-h-64 flex-col overflow-y-auto pr-1">
            {facets.brands.map((option) => (
              <Checkbox
                key={option.value}
                label={option.label}
                count={option.count}
                checked={isChecked("brand", option.value)}
                onChange={() => onToggle("brand", option.value)}
              />
            ))}
          </div>
        </Accordion>
      ) : null}

      <Accordion title="Customer rating">
        <div className="flex flex-col gap-2 pt-1">
          {RATINGS.map((rating) => {
            const active = query.minRating === rating;
            return (
              <button
                key={rating}
                type="button"
                onClick={() => onRatingChange(rating)}
                aria-pressed={active}
                className={cn(
                  "inline-flex items-center gap-2 rounded-control border px-3 py-2 text-left text-sm transition-colors",
                  active ? "border-ink bg-cream-deep" : "border-ink-200 hover:border-ink",
                )}
              >
                <span className="inline-flex" aria-hidden="true">
                  {Array.from({ length: rating }, (_, index) => (
                    <Star
                      key={index}
                      className="h-3.5 w-3.5 fill-copper-500 text-copper-500"
                      strokeWidth={1.5}
                    />
                  ))}
                </span>
                <span className="text-ink-700">&amp; above</span>
              </button>
            );
          })}
        </div>
      </Accordion>

      <Accordion title="Discount">
        <div className="flex flex-wrap gap-2 pt-1">
          {DISCOUNTS.map((discount) => {
            const active = query.minDiscount === discount;
            return (
              <button
                key={discount}
                type="button"
                onClick={() => onDiscountChange(discount)}
                aria-pressed={active}
                className={cn(
                  "rounded-control border px-3 py-2 text-xs transition-colors",
                  active
                    ? "border-ink bg-ink text-cream"
                    : "border-ink-200 text-ink hover:border-ink",
                )}
              >
                {discount}% and above
              </button>
            );
          })}
        </div>
      </Accordion>

      <Accordion title="Availability" defaultOpen>
        <Checkbox
          label="In stock only"
          checked={Boolean(query.inStockOnly)}
          onChange={(event) => onStockChange(event.target.checked)}
        />
      </Accordion>
    </div>
  );
}

function ActiveCount({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-ink px-1.5 text-[0.625rem] font-medium text-cream tabular-nums">
      {value}
    </span>
  );
}

/**
 * Price range, as two number inputs plus quick bands.
 *
 * Inputs are local state committed on blur or Enter rather than on every
 * keystroke — typing "1500" should not fire four separate navigations.
 */
function PriceFilter({
  min,
  max,
  value,
  onChange,
}: {
  min: number;
  max: number;
  value: [number | undefined, number | undefined];
  onChange: (min?: number, max?: number) => void;
}) {
  /**
   * Local input state, seeded from the committed filter.
   *
   * Kept in sync with the outside world by remounting rather than by an
   * effect: the parent keys this component on the committed price range, so
   * clearing filters elsewhere gives a fresh component with fresh initial
   * state. That is React's recommended way to reset state on a prop change,
   * and it removes a whole class of "state drifted from props" bug.
   */
  const [lower, setLower] = useState(value[0]?.toString() ?? "");
  const [upper, setUpper] = useState(value[1]?.toString() ?? "");

  const commit = () => {
    const parsedLower = lower.trim() === "" ? undefined : Number(lower);
    const parsedUpper = upper.trim() === "" ? undefined : Number(upper);
    onChange(
      Number.isFinite(parsedLower) ? parsedLower : undefined,
      Number.isFinite(parsedUpper) ? parsedUpper : undefined,
    );
  };

  const bands: [number, number | undefined][] = [
    [0, 999],
    [1000, 2499],
    [2500, 4999],
    [5000, undefined],
  ];

  return (
    <Accordion title="Price" defaultOpen>
      <div className="pt-1">
        <div className="flex items-center gap-2">
          <label className="flex-1">
            <span className="sr-only">Minimum price</span>
            <input
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              value={lower}
              placeholder={formatPrice(min)}
              onChange={(event) => setLower(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                }
              }}
              className="h-10 w-full rounded-control border border-ink-200 bg-shell px-2.5 text-sm text-ink placeholder:text-ink-400 focus:border-copper-500"
            />
          </label>

          <span className="text-ink-300" aria-hidden="true">
            &ndash;
          </span>

          <label className="flex-1">
            <span className="sr-only">Maximum price</span>
            <input
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              value={upper}
              placeholder={formatPrice(max)}
              onChange={(event) => setUpper(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                }
              }}
              className="h-10 w-full rounded-control border border-ink-200 bg-shell px-2.5 text-sm text-ink placeholder:text-ink-400 focus:border-copper-500"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {bands.map(([bandMin, bandMax]) => {
            const active = value[0] === bandMin && value[1] === bandMax;
            return (
              <button
                key={`${bandMin}-${bandMax ?? "up"}`}
                type="button"
                onClick={() => (active ? onChange(undefined, undefined) : onChange(bandMin, bandMax))}
                aria-pressed={active}
                className={cn(
                  "rounded-pill border px-3 py-1.5 text-xs transition-colors",
                  active
                    ? "border-ink bg-ink text-cream"
                    : "border-ink-200 text-ink-700 hover:border-ink",
                )}
              >
                {bandMax
                  ? `${formatPrice(bandMin)} – ${formatPrice(bandMax)}`
                  : `${formatPrice(bandMin)}+`}
              </button>
            );
          })}
        </div>
      </div>
    </Accordion>
  );
}
