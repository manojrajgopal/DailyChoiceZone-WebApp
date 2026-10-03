"use client";

import { useId, useState } from "react";
import { Star } from "lucide-react";

import type { AttributeFacet, FacetOption, PriceBucket, ProductFacets, ProductQuery } from "@/types";

import { Accordion } from "@/components/ui/Accordion";
import { Checkbox } from "@/components/ui/Field";
import { cn } from "@/lib/utils/cn";
import { formatPrice, humanize } from "@/lib/utils/format";
import {
  clearAttribute,
  toggleAttributeValue,
  toggleFilterValue,
  withAttributeRange,
  withAvailability,
  withMinDiscount,
  withMinRating,
  withPriceRange,
  type MultiFilterKey,
} from "@/lib/filters/search-params";

import { useSiteContent } from "@/hooks/useSiteContent";

export interface FilterPanelProps {
  facets: ProductFacets;
  /** The removable, user-chosen filters (route-locked ones are not in here). */
  query: ProductQuery;
  /**
   * The next query after a filter change. The listing writes it to the URL on
   * desktop, or into a staged draft inside the mobile drawer.
   */
  onChange: (next: ProductQuery) => void;
  /** Hidden on a category page, where the category is already fixed. */
  showCategoryFilter?: boolean;
  className?: string;
}

const sameValue = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The filter panel.
 *
 * One component serves the desktop sidebar and the mobile drawer. Options and
 * counts come from the API's facets for the *current* filters (disjunctive:
 * each section ignores its own selection, so ticking one brand still shows
 * how many the others have). An option with nothing behind it is disabled
 * unless it is already selected — a shopper must always be able to untick.
 *
 * Ratings, discounts and price bands come from the server when it sends them,
 * falling back to the store's content document's presets.
 */
export function FilterPanel({
  facets,
  query,
  onChange,
  showCategoryFilter = true,
  className,
}: FilterPanelProps) {
  const content = useSiteContent();

  const isChecked = (key: MultiFilterKey, value: string) =>
    (query[key] ?? []).some((entry) => sameValue(entry, value));
  const countFor = (key: MultiFilterKey) => (query[key] ?? []).length;
  const toggle = (key: MultiFilterKey, value: string) => onChange(toggleFilterValue(query, key, value));

  const serverRatings = facets.ratings ?? [];
  const serverDiscounts = facets.discounts ?? [];
  const attributes = facets.attributes ?? [];

  return (
    <div className={cn("flex flex-col", className)}>
      {showCategoryFilter && (facets.categories.length > 1 || countFor("category") > 0) ? (
        <Accordion title="Category" defaultOpen meta={<ActiveCount value={countFor("category")} />}>
          <OptionList
            options={facets.categories}
            isChecked={(value) => isChecked("category", value)}
            onToggle={(value) => toggle("category", value)}
          />
        </Accordion>
      ) : null}

      {facets.subcategories.length > 1 || countFor("subcategory") > 0 ? (
        <Accordion title="Product type" defaultOpen meta={<ActiveCount value={countFor("subcategory")} />}>
          <OptionList
            options={facets.subcategories}
            label={(option) => humanize(option.value)}
            isChecked={(value) => isChecked("subcategory", value)}
            onToggle={(value) => toggle("subcategory", value)}
          />
        </Accordion>
      ) : null}

      <PriceFilter
        // Remount whenever the committed range changes, so the inputs reseed.
        key={`${query.minPrice ?? ""}-${query.maxPrice ?? ""}`}
        min={facets.priceRange.min}
        max={facets.priceRange.max}
        buckets={facets.priceBuckets}
        value={[query.minPrice, query.maxPrice]}
        onChange={(min, max) => onChange(withPriceRange(query, min, max))}
      />

      {facets.sizes.length > 0 ? (
        <Accordion
          title="Size"
          defaultOpen={countFor("size") > 0}
          meta={<ActiveCount value={countFor("size")} />}
        >
          <div className="flex flex-wrap gap-2 pt-1">
            {facets.sizes.map((option) => {
              const active = isChecked("size", option.value);
              const empty = option.count === 0 && !active;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => toggle("size", option.value)}
                  aria-pressed={active}
                  disabled={empty}
                  aria-label={`${option.label || option.value} (${option.count})`}
                  className={cn(
                    "inline-flex h-9 min-w-[2.75rem] items-center justify-center rounded-control border px-3 text-xs transition-colors",
                    active
                      ? "border-ink bg-ink text-cream"
                      : "border-ink-200 bg-shell text-ink hover:border-ink",
                    "disabled:cursor-not-allowed disabled:border-ink-100 disabled:text-ink-300 disabled:hover:border-ink-100",
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
        <Accordion
          title="Colour"
          defaultOpen={countFor("color") > 0}
          meta={<ActiveCount value={countFor("color")} />}
        >
          <OptionList
            options={facets.colors}
            isChecked={(value) => isChecked("color", value)}
            onToggle={(value) => toggle("color", value)}
            swatch
          />
        </Accordion>
      ) : null}

      {facets.brands.length > 1 || countFor("brand") > 0 ? (
        <Accordion
          title="Brand"
          defaultOpen={countFor("brand") > 0}
          meta={<ActiveCount value={countFor("brand")} />}
        >
          <OptionList
            options={facets.brands}
            isChecked={(value) => isChecked("brand", value)}
            onToggle={(value) => toggle("brand", value)}
          />
        </Accordion>
      ) : null}

      {attributes.map((attribute) => (
        <AttributeSection key={attribute.code} attribute={attribute} query={query} onChange={onChange} />
      ))}

      <Accordion
        title="Customer rating"
        defaultOpen={typeof query.minRating === "number"}
        meta={<ActiveCount value={typeof query.minRating === "number" ? 1 : 0} />}
      >
        <div className="flex flex-col gap-2 pt-1">
          {(serverRatings.length
            ? serverRatings.map((option) => ({ value: Number(option.value), count: option.count as number | undefined }))
            : (content?.ratingFilters ?? []).map((value) => ({ value, count: undefined as number | undefined }))
          )
            .filter((option) => Number.isFinite(option.value) && option.value > 0)
            .map((option) => {
              const active = query.minRating === option.value;
              const empty = option.count === 0 && !active;
              const stars = Math.min(5, Math.round(option.value));
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChange(withMinRating(query, option.value))}
                  aria-pressed={active}
                  disabled={empty}
                  aria-label={`${option.value} stars and above${typeof option.count === "number" ? ` (${option.count})` : ""}`}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-control border px-3 py-2 text-left text-sm transition-colors",
                    active ? "border-ink bg-cream-deep" : "border-ink-200 hover:border-ink",
                    "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-ink-200",
                  )}
                >
                  <span className="inline-flex" aria-hidden="true">
                    {Array.from({ length: stars }, (_, index) => (
                      <Star
                        key={index}
                        className="h-3.5 w-3.5 fill-copper-500 text-copper-500"
                        strokeWidth={1.5}
                      />
                    ))}
                  </span>
                  <span className="text-ink-700">&amp; above</span>
                  {typeof option.count === "number" ? (
                    <span className="ml-auto text-xs text-ink-400 tabular-nums">{option.count}</span>
                  ) : null}
                </button>
              );
            })}
        </div>
      </Accordion>

      <Accordion
        title="Discount"
        defaultOpen={typeof query.minDiscount === "number"}
        meta={<ActiveCount value={typeof query.minDiscount === "number" ? 1 : 0} />}
      >
        <div className="flex flex-wrap gap-2 pt-1">
          {(serverDiscounts.length
            ? serverDiscounts.map((option) => ({ value: Number(option.value), count: option.count as number | undefined }))
            : (content?.discountFilters ?? []).map((value) => ({ value, count: undefined as number | undefined }))
          )
            .filter((option) => Number.isFinite(option.value) && option.value > 0)
            .map((option) => {
              const active = query.minDiscount === option.value;
              const empty = option.count === 0 && !active;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChange(withMinDiscount(query, option.value))}
                  aria-pressed={active}
                  disabled={empty}
                  className={cn(
                    "rounded-control border px-3 py-2 text-xs transition-colors",
                    active
                      ? "border-ink bg-ink text-cream"
                      : "border-ink-200 text-ink hover:border-ink",
                    "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-ink-200",
                  )}
                >
                  {option.value}% and above
                  {typeof option.count === "number" ? (
                    <span className={cn("ml-1.5 tabular-nums", active ? "text-cream/80" : "text-ink-400")}>
                      {option.count}
                    </span>
                  ) : null}
                </button>
              );
            })}
        </div>
      </Accordion>

      <AvailabilitySection facets={facets} query={query} onChange={onChange} />
    </div>
  );
}

/* ---------------------------------------------------------------- pieces */

function ActiveCount({ value }: { value: number }) {
  if (value === 0) return null;
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-pill bg-ink px-1.5 text-[0.625rem] font-medium text-cream tabular-nums">
      {value}
    </span>
  );
}

/** Checkboxes with counts; zero-count options are disabled unless selected. */
function OptionList({
  options,
  isChecked,
  onToggle,
  label,
  swatch = false,
}: {
  options: FacetOption[];
  isChecked: (value: string) => boolean;
  onToggle: (value: string) => void;
  label?: (option: FacetOption) => string;
  swatch?: boolean;
}) {
  return (
    <div className="scroll-panel flex max-h-64 flex-col overflow-y-auto pr-1">
      {options.map((option) => {
        const checked = isChecked(option.value);
        const text = label ? label(option) : option.label || option.value;
        return (
          <Checkbox
            key={option.value}
            label={
              swatch && option.hex ? (
                <span className="inline-flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 rounded-full border border-ink-200"
                    style={{ backgroundColor: option.hex }}
                    aria-hidden="true"
                  />
                  {text}
                </span>
              ) : (
                text
              )
            }
            count={option.count}
            checked={checked}
            disabled={option.count === 0 && !checked}
            onChange={() => onToggle(option.value)}
          />
        );
      })}
    </div>
  );
}

function AvailabilitySection({
  facets,
  query,
  onChange,
}: {
  facets: ProductFacets;
  query: ProductQuery;
  onChange: (next: ProductQuery) => void;
}) {
  const current = query.availability ?? (query.inStockOnly ? "in-stock" : undefined);
  const counts = facets.availability;

  return (
    <Accordion title="Availability" defaultOpen meta={<ActiveCount value={current ? 1 : 0} />}>
      <div className="flex flex-col">
        <Checkbox
          label="In stock"
          count={counts?.inStock}
          checked={current === "in-stock"}
          disabled={counts !== undefined && counts.inStock === 0 && current !== "in-stock"}
          onChange={() => onChange(withAvailability(query, "in-stock"))}
        />
        {counts ? (
          <Checkbox
            label="Out of stock"
            count={counts.outOfStock}
            checked={current === "out-of-stock"}
            disabled={counts.outOfStock === 0 && current !== "out-of-stock"}
            onChange={() => onChange(withAvailability(query, "out-of-stock"))}
          />
        ) : null}
      </div>
    </Accordion>
  );
}

/** One dynamic attribute: checkboxes for select / multi / boolean, a range for numbers. */
function AttributeSection({
  attribute,
  query,
  onChange,
}: {
  attribute: AttributeFacet;
  query: ProductQuery;
  onChange: (next: ProductQuery) => void;
}) {
  const selected = query.attributes?.[attribute.code] ?? [];
  const range = query.attributeRanges?.[attribute.code];
  const hasRange = typeof range?.min === "number" || typeof range?.max === "number";

  if (attribute.type === "number") {
    if (!attribute.range && !hasRange) return null;
    return (
      <Accordion title={attribute.label} defaultOpen={hasRange} meta={<ActiveCount value={hasRange ? 1 : 0} />}>
        <RangeFilter
          key={`${range?.min ?? ""}-${range?.max ?? ""}`}
          label={attribute.label}
          unit={attribute.unit}
          bounds={attribute.range}
          value={[range?.min, range?.max]}
          onApply={(min, max) => onChange(withAttributeRange(query, attribute.code, min, max))}
          onClear={() => onChange(clearAttribute(query, attribute.code))}
        />
      </Accordion>
    );
  }

  if (attribute.options.length === 0 && selected.length === 0) return null;

  const options =
    attribute.type === "boolean"
      ? attribute.options.map((option) => ({
          ...option,
          label: option.label || (option.value === "true" ? "Yes" : "No"),
        }))
      : attribute.options;

  return (
    <Accordion
      title={attribute.label}
      defaultOpen={selected.length > 0}
      meta={<ActiveCount value={selected.length} />}
    >
      <OptionList
        options={options}
        isChecked={(value) => selected.some((entry) => sameValue(entry, value))}
        onToggle={(value) => onChange(toggleAttributeValue(query, attribute.code, value))}
      />
    </Accordion>
  );
}

function parseBound(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

const INPUT =
  "h-10 w-full rounded-control border border-ink-200 bg-shell px-2.5 text-sm text-ink placeholder:text-ink-400 focus:border-copper-500";

/**
 * A number attribute's min / max, applied with a button (or Enter) so typing
 * "1500" is one filter change, not four.
 */
function RangeFilter({
  label,
  unit,
  bounds,
  value,
  onApply,
  onClear,
}: {
  label: string;
  unit: string;
  bounds: { min: number; max: number } | null;
  value: [number | undefined, number | undefined];
  onApply: (min?: number, max?: number) => void;
  onClear: () => void;
}) {
  const id = useId();
  const [lower, setLower] = useState(value[0]?.toString() ?? "");
  const [upper, setUpper] = useState(value[1]?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const suffix = unit ? ` (${unit})` : "";
  const active = typeof value[0] === "number" || typeof value[1] === "number";

  const apply = () => {
    const min = parseBound(lower);
    const max = parseBound(upper);
    if (typeof min === "number" && typeof max === "number" && min > max) {
      setError("The minimum must not be more than the maximum.");
      return;
    }
    setError(null);
    onApply(min, max);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      apply();
    }
  };

  return (
    <div className="pt-1">
      <div className="flex items-center gap-2">
        <label className="flex-1">
          <span className="sr-only">{`Minimum ${label}${suffix}`}</span>
          <input
            type="number"
            inputMode="decimal"
            value={lower}
            min={bounds?.min}
            max={bounds?.max}
            placeholder={bounds ? `${bounds.min}${unit ? ` ${unit}` : ""}` : "Min"}
            onChange={(event) => setLower(event.target.value)}
            onKeyDown={onKeyDown}
            aria-describedby={error ? `${id}-error` : undefined}
            className={INPUT}
          />
        </label>
        <span className="text-ink-300" aria-hidden="true">
          &ndash;
        </span>
        <label className="flex-1">
          <span className="sr-only">{`Maximum ${label}${suffix}`}</span>
          <input
            type="number"
            inputMode="decimal"
            value={upper}
            min={bounds?.min}
            max={bounds?.max}
            placeholder={bounds ? `${bounds.max}${unit ? ` ${unit}` : ""}` : "Max"}
            onChange={(event) => setUpper(event.target.value)}
            onKeyDown={onKeyDown}
            aria-describedby={error ? `${id}-error` : undefined}
            className={INPUT}
          />
        </label>
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={apply}
          className="rounded-control border border-ink bg-ink px-3 py-1.5 text-xs text-cream transition-colors hover:bg-ink-700"
        >
          Apply
        </button>
        {active ? (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-ink-500 underline transition-colors hover:text-ink"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The fallback price bands, when the API sends none. */
const FALLBACK_BANDS: PriceBucket[] = [
  { min: 0, max: 999, label: "", count: -1 },
  { min: 1000, max: 2499, label: "", count: -1 },
  { min: 2500, max: 4999, label: "", count: -1 },
  { min: 5000, max: null, label: "", count: -1 },
];

function bandLabel(bucket: PriceBucket): string {
  if (bucket.label) return bucket.label;
  return bucket.max !== null
    ? `${formatPrice(bucket.min)} – ${formatPrice(bucket.max)}`
    : `${formatPrice(bucket.min)}+`;
}

/**
 * Price range, as two number inputs plus quick bands (the server's buckets,
 * with counts, when it sends them).
 *
 * Inputs are local state committed on blur or Enter rather than on every
 * keystroke — typing "1500" should not fire four separate navigations.
 */
function PriceFilter({
  min,
  max,
  buckets,
  value,
  onChange,
}: {
  min: number;
  max: number;
  buckets?: PriceBucket[];
  value: [number | undefined, number | undefined];
  onChange: (min?: number, max?: number) => void;
}) {
  /*
   * Local input state, seeded from the committed filter, kept in step by the
   * parent remounting this on a change to the committed range.
   */
  const [lower, setLower] = useState(value[0]?.toString() ?? "");
  const [upper, setUpper] = useState(value[1]?.toString() ?? "");

  const commit = () => {
    const parsedLower = parseBound(lower);
    const parsedUpper = parseBound(upper);
    if (parsedLower === value[0] && parsedUpper === value[1]) return;
    onChange(parsedLower, parsedUpper);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  const bands = buckets && buckets.length > 0 ? buckets : FALLBACK_BANDS;
  const active = typeof value[0] === "number" || typeof value[1] === "number";

  return (
    <Accordion title="Price" defaultOpen meta={<ActiveCount value={active ? 1 : 0} />}>
      <div className="pt-1">
        <div className="flex items-center gap-2">
          <label className="flex-1">
            <span className="sr-only">Minimum price</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              value={lower}
              placeholder={formatPrice(min)}
              onChange={(event) => setLower(event.target.value)}
              onBlur={commit}
              onKeyDown={onKeyDown}
              className={INPUT}
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
              min={0}
              value={upper}
              placeholder={formatPrice(max)}
              onChange={(event) => setUpper(event.target.value)}
              onBlur={commit}
              onKeyDown={onKeyDown}
              className={INPUT}
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {bands.map((bucket) => {
            const bandMax = bucket.max ?? undefined;
            const selected = value[0] === bucket.min && value[1] === bandMax;
            const counted = bucket.count >= 0;
            const empty = counted && bucket.count === 0 && !selected;
            return (
              <button
                key={`${bucket.min}-${bucket.max ?? "up"}`}
                type="button"
                onClick={() => (selected ? onChange(undefined, undefined) : onChange(bucket.min, bandMax))}
                aria-pressed={selected}
                disabled={empty}
                className={cn(
                  "rounded-pill border px-3 py-1.5 text-xs transition-colors",
                  selected
                    ? "border-ink bg-ink text-cream"
                    : "border-ink-200 text-ink-700 hover:border-ink",
                  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-ink-200",
                )}
              >
                {bandLabel(bucket)}
                {counted ? (
                  <span className={cn("ml-1.5 tabular-nums", selected ? "text-cream/80" : "text-ink-400")}>
                    {bucket.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </Accordion>
  );
}
