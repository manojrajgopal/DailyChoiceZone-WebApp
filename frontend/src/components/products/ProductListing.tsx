"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import { SORT_OPTIONS, type ProductQuery } from "@/types";

import { ActiveFilterChips } from "@/components/filters/ActiveFilterChips";
import { FilterPanel } from "@/components/filters/FilterPanel";
import { EmptyState, ErrorState } from "@/components/common/States";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Dialog";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Field";
import { useProductQuery } from "@/hooks/useProductQuery";
import { useFacets, useProducts } from "@/hooks/useProducts";

import { ProductGrid } from "./ProductGrid";

export interface ProductListingProps {
  /** Where filter changes are pushed, e.g. `/shop`. */
  basePath: string;
  /** Filters implied by the route: a category page locks its category. */
  locked?: Pick<ProductQuery, "category" | "query">;
  /** Hide the category filter where the route already fixes it. */
  showCategoryFilter?: boolean;
  /** Scope the facet counts, usually the same as `locked`. */
  facetScope?: Pick<ProductQuery, "category" | "subcategory" | "query">;
  /** Shown above the grid when there are no results at all. */
  emptyTitle?: string;
  emptyDescription?: string;
}

/**
 * The shared product listing.
 *
 * Every browse surface in the store — /shop, category pages and search — is
 * this one component with a different `basePath` and `locked` filter. That is
 * the point: filters, sorting, pagination, empty states and the mobile filter
 * sheet are implemented once and behave identically everywhere.
 */
export function ProductListing({
  basePath,
  locked,
  showCategoryFilter = true,
  facetScope,
  emptyTitle = "Nothing matches those filters",
  emptyDescription = "Try removing a filter or two, or widen your price range.",
}: ProductListingProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);

  const {
    query,
    urlQuery,
    activeFilterCount,
    setSort,
    toggleFilter,
    setPriceRange,
    setMinRating,
    setMinDiscount,
    setInStockOnly,
    setPage,
    clearAll,
  } = useProductQuery({ basePath, locked });

  const { data: page, error, isLoading, reload } = useProducts(query);
  const { data: facets } = useFacets(facetScope);

  const filterHandlers = {
    onToggle: toggleFilter,
    onPriceChange: setPriceRange,
    onRatingChange: setMinRating,
    onDiscountChange: setMinDiscount,
    onStockChange: setInStockOnly,
  };

  const total = page?.totalPages ?? 1;
  const resultCount = page?.total ?? 0;

  return (
    <div className="lg:grid lg:grid-cols-[16rem_1fr] lg:gap-10">
      {/* --------------------------------------------- desktop filter rail */}
      <aside className="hidden lg:block">
        <div className="sticky top-28">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="label-wide text-ink">Filters</h2>
            {activeFilterCount > 0 ? (
              <button
                type="button"
                onClick={clearAll}
                className="text-xs text-ink-500 underline transition-colors hover:text-ink"
              >
                Clear all
              </button>
            ) : null}
          </div>

          {facets ? (
            <FilterPanel
              facets={facets}
              query={urlQuery}
              showCategoryFilter={showCategoryFilter}
              {...filterHandlers}
            />
          ) : (
            <p className="py-4 text-sm text-ink-400">Loading filters…</p>
          )}
        </div>
      </aside>

      {/* ------------------------------------------------------- results */}
      <div className="min-w-0">
        {/* --- toolbar --- */}
        <div className="flex items-center justify-between gap-3 border-b border-ink-200 pb-4">
          <p className="text-sm text-ink-500 tabular-nums" aria-live="polite">
            {isLoading ? (
              "Loading…"
            ) : (
              <>
                <span className="font-medium text-ink">{resultCount.toLocaleString("en-IN")}</span>{" "}
                {resultCount === 1 ? "product" : "products"}
              </>
            )}
          </p>

          {/*
            `min-w-0 flex-1` on small screens lets these two controls share
            whatever space is left beside the result count. Without it the
            sort select held a fixed 184px and pushed the whole page into a
            horizontal scroll on a 375px phone.
          */}
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFiltersOpen(true)}
              className="shrink-0 lg:hidden"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Filters
              {activeFilterCount > 0 ? (
                <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-pill bg-ink px-1 text-[0.625rem] text-cream tabular-nums">
                  {activeFilterCount}
                </span>
              ) : null}
            </Button>

            <Select
              aria-label="Sort products"
              options={SORT_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              value={urlQuery.sort ?? "recommended"}
              onChange={(event) =>
                setSort(event.target.value as (typeof SORT_OPTIONS)[number]["value"])
              }
              className="min-w-0 flex-1 sm:flex-none"
              selectClassName="h-9 w-full text-[0.8125rem] sm:w-[11.5rem]"
            />
          </div>
        </div>

        {/* --- active filters --- */}
        {activeFilterCount > 0 ? (
          <div className="pt-4">
            <ActiveFilterChips
              query={urlQuery}
              onClearAll={clearAll}
              {...filterHandlers}
            />
          </div>
        ) : null}

        {/* --- grid --- */}
        <div className="pt-6">
          {error ? (
            <ErrorState
              title="We could not load these products"
              description="Something went wrong fetching the catalogue."
              onRetry={reload}
            />
          ) : isLoading ? (
            <ProductGrid products={[]} isLoading skeletonCount={12} />
          ) : resultCount === 0 ? (
            <EmptyState
              icon="search"
              title={emptyTitle}
              description={emptyDescription}
              action={{ label: "Browse everything", href: "/shop" }}
              secondaryAction={
                activeFilterCount > 0 ? { label: "Clear filters", onClick: clearAll } : undefined
              }
            />
          ) : (
            <>
              <ProductGrid products={page?.items ?? []} prioritiseFirstRow />

              {total > 1 ? (
                <Pagination
                  page={page?.page ?? 1}
                  totalPages={total}
                  onPageChange={setPage}
                  className="mt-14"
                />
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* ----------------------------------------- mobile filter sheet */}
      <Drawer
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title="Filters"
        side="bottom"
        footer={
          <div className="flex gap-2">
            <Button
              variant="outline"
              fullWidth
              onClick={() => {
                clearAll();
                setFiltersOpen(false);
              }}
            >
              Clear all
            </Button>
            <Button fullWidth onClick={() => setFiltersOpen(false)}>
              Show {resultCount.toLocaleString("en-IN")} results
            </Button>
          </div>
        }
      >
        <div className="px-4 pb-2">
          {facets ? (
            <FilterPanel
              facets={facets}
              query={urlQuery}
              showCategoryFilter={showCategoryFilter}
              {...filterHandlers}
            />
          ) : (
            <p className="py-4 text-sm text-ink-400">Loading filters…</p>
          )}
        </div>
      </Drawer>
    </div>
  );
}
