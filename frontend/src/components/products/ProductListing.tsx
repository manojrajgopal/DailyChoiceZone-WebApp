"use client";

import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";

import type { ProductFacets, ProductQuery, SortOption } from "@/types";

import { ActiveFilterChips } from "@/components/filters/ActiveFilterChips";
import { FilterPanel } from "@/components/filters/FilterPanel";
import { EmptyState, ErrorState } from "@/components/common/States";
import { SearchCorrection } from "@/components/search/SearchCorrection";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Dialog";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Field";
import { useProductQuery } from "@/hooks/useProductQuery";
import { useFacets, useProducts } from "@/hooks/useProducts";
import { useSiteContent } from "@/hooks/useSiteContent";
import { countActiveFilters } from "@/lib/filters/apply-filters";
import { buildQueryString, clearFilters, defaultSort } from "@/lib/filters/search-params";
import { sortOptionsFor } from "@/lib/filters/sort-options";
import { productIdFromHref } from "@/lib/discovery/tracking";
import { resultPosition, trackSearchClick } from "@/services/searchService";

import { ProductGrid } from "./ProductGrid";

export interface ProductListingProps {
  /** Where filter changes are pushed, e.g. `/shop`. */
  basePath: string;
  /** Filters implied by the route: a category page locks its category. */
  locked?: Pick<ProductQuery, "category" | "query">;
  /** Hide the category filter where the route already fixes it. */
  showCategoryFilter?: boolean;
  /**
   * Extra facet scope. The facets are always computed for the full current
   * query (route-locked filters included); this is merged underneath it.
   */
  facetScope?: Pick<ProductQuery, "category" | "subcategory" | "query">;
  /** Shown above the grid when there are no results at all. */
  emptyTitle?: string;
  emptyDescription?: string;
  /** Rendered under the empty state, e.g. popular searches on the search page. */
  emptyExtra?: ReactNode;
}

/** How many results a facet set says the query has (its availability counts cover every result). */
function resultCountFromFacets(facets: ProductFacets | null | undefined, query: ProductQuery): number | null {
  const counts = facets?.availability;
  if (!counts) return null;
  const availability = query.availability ?? (query.inStockOnly ? "in-stock" : undefined);
  if (availability === "in-stock") return counts.inStock;
  if (availability === "out-of-stock") return counts.outOfStock;
  return counts.inStock + counts.outOfStock;
}

/**
 * The shared product listing.
 *
 * Every browse surface in the store — /shop, category pages and search — is
 * this one component with a different `basePath` and `locked` filter. That is
 * the point: filters, sorting, pagination, empty states and the mobile filter
 * drawer are implemented once and behave identically everywhere.
 *
 * Filters live in the URL (`push` per change, so back undoes them). The
 * mobile drawer stages its changes in a draft — with its own facet counts —
 * and writes them in one go on Apply.
 */
export function ProductListing({
  basePath,
  locked,
  showCategoryFilter = true,
  facetScope,
  emptyTitle = "Nothing matches those filters",
  emptyDescription = "Try removing a filter or two, or widen your price range.",
  emptyExtra,
}: ProductListingProps) {
  const content = useSiteContent();

  const { query, urlQuery, activeFilterCount, setSort, setPage, clearAll, apply } = useProductQuery({
    basePath,
    locked,
  });

  const withLocked = (filters: ProductQuery): ProductQuery => ({
    ...facetScope,
    ...filters,
    ...(locked?.category ? { category: locked.category } : {}),
    ...(locked?.query ? { query: locked.query } : {}),
  });

  const { data: page, error, isLoading, reload } = useProducts(query);
  const { data: facets } = useFacets(withLocked(urlQuery));

  /* ------------------------------------------------ mobile drawer draft */

  const [draft, setDraft] = useState<ProductQuery | null>(null);
  const filtersOpen = draft !== null;
  const draftChanged = draft !== null && buildQueryString(draft) !== buildQueryString(urlQuery);
  const { data: draftFacetData } = useFacets(draft ? withLocked(draft) : undefined, { enabled: draftChanged });
  const drawerFacets = draftChanged ? (draftFacetData ?? facets) : facets;
  const draftCount = draftChanged ? resultCountFromFacets(draftFacetData, draft) : (page?.total ?? null);

  /* ----------------------------------------------------- search clicks */

  /*
   * The search id arrives on page 1 only (later pages are not new searches),
   * so the latest one is kept for clicks on page 2 and beyond. Adjusted during
   * render rather than in an effect, as React recommends for derived state.
   */
  const latestSearchId = page?.search?.searchId ?? null;
  const [searchId, setSearchId] = useState<number | null>(null);
  if (latestSearchId !== null && latestSearchId !== searchId) setSearchId(latestSearchId);

  const onResultClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (!searchId || !page) return;
    const link = (event.target as HTMLElement | null)?.closest?.("a[href]");
    const productId = productIdFromHref(link?.getAttribute("href"));
    if (!productId) return;
    const index = page.items.findIndex((product) => product.id === productId || product.slug === productId);
    const product = page.items[index];
    if (!product) return;
    trackSearchClick({
      searchId,
      productId: product.id,
      position: resultPosition(page.page, page.pageSize || query.pageSize || 1, index),
    });
  };

  /* ------------------------------------------------------------ sorting */

  const hasTerm = Boolean(query.query?.trim());
  const sortOptions = sortOptionsFor(hasTerm, content?.sortOptions ?? []);
  const currentSort: SortOption = urlQuery.sort ?? defaultSort(query);

  const total = page?.totalPages ?? 1;
  const resultCount = page?.total ?? 0;

  return (
    <div className="lg:grid lg:grid-cols-[16rem_1fr] lg:gap-10">
      {/* --------------------------------------------- desktop filter rail */}
      <aside className="hidden lg:block" aria-label="Filters">
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
              onChange={(next) => apply(next)}
            />
          ) : (
            <p className="py-4 text-sm text-ink-400">Loading filters…</p>
          )}
        </div>
      </aside>

      {/* ------------------------------------------------------- results */}
      <div className="min-w-0">
        <SearchCorrection meta={page?.search} />

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
              onClick={() => setDraft(urlQuery)}
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
              options={sortOptions}
              value={currentSort}
              onChange={(event) => setSort(event.target.value as SortOption)}
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
              facets={facets}
              onChange={(next) => apply(next)}
              onClearAll={clearAll}
            />
          </div>
        ) : null}

        {/* --- grid --- */}
        <div className="pt-6">
          {error ? (
            <ErrorState
              title="We could not load these products"
              description="We couldn't load these products. Please try again in a moment."
              onRetry={reload}
            />
          ) : isLoading ? (
            <ProductGrid products={[]} isLoading skeletonCount={12} />
          ) : resultCount === 0 ? (
            <>
              <EmptyState
                icon="search"
                title={emptyTitle}
                description={emptyDescription}
                action={{ label: "Browse everything", href: "/shop" }}
                secondaryAction={
                  activeFilterCount > 0 ? { label: "Clear filters", onClick: clearAll } : undefined
                }
              />
              {emptyExtra}
            </>
          ) : (
            <>
              {/* Delegated click capture: the cards need no tracking code of their own. */}
              <div onClickCapture={onResultClick} onAuxClickCapture={onResultClick}>
                <ProductGrid
                  products={page?.items ?? []}
                  colourFilter={query.color ?? []}
                  prioritiseFirstRow
                />
              </div>

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

      {/* ----------------------------------------- mobile filter drawer */}
      <Drawer
        open={filtersOpen}
        onOpenChange={(open) => setDraft(open ? (draft ?? urlQuery) : null)}
        title="Filters"
        side="bottom"
        footer={
          <div className="flex gap-2">
            <Button
              variant="outline"
              fullWidth
              disabled={!draft || countActiveFilters(draft) === 0}
              onClick={() => setDraft((current) => (current ? clearFilters(current) : current))}
            >
              Clear all
            </Button>
            <Button
              fullWidth
              onClick={() => {
                if (draft && draftChanged) apply(draft);
                setDraft(null);
              }}
            >
              {draftCount === null
                ? "Apply"
                : `Show ${draftCount.toLocaleString("en-IN")} ${draftCount === 1 ? "result" : "results"}`}
            </Button>
          </div>
        }
      >
        <div className="px-4 pb-2">
          {drawerFacets && draft ? (
            <FilterPanel
              facets={drawerFacets}
              query={draft}
              showCategoryFilter={showCategoryFilter}
              onChange={setDraft}
            />
          ) : (
            <p className="py-4 text-sm text-ink-400">Loading filters…</p>
          )}
        </div>
      </Drawer>
    </div>
  );
}
