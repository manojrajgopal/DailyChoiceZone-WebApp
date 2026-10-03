"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { EmptyState } from "@/components/common/States";
import { ProductListing } from "@/components/products/ProductListing";
import { addRecentSearch } from "@/lib/search/recent-searches";

import { PopularSearches } from "./PopularSearches";

/**
 * Search results.
 *
 * The term is read in the browser rather than from server-side
 * `searchParams`, because this site is exported as static HTML and there is no
 * server to read a query string during rendering. One `/search/index.html` is
 * built, and it reads `?q=` on load.
 *
 * Results themselves are the same `ProductListing` used by /shop and every
 * category page, so search keeps the full filter and sort toolbar rather than
 * being a stripped-down secondary screen.
 */
export function SearchView() {
  const searchParams = useSearchParams();
  const term = (searchParams?.get("q") ?? "").trim();

  // Remembered in this browser only, for the search box's "Recent searches".
  useEffect(() => {
    if (term) addRecentSearch(term);
  }, [term]);

  return (
    <div className="page-shell py-8 sm:py-10">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Search" }]} />

      <header className="mt-4 mb-8">
        <h1 className="font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">
          {term ? (
            <>
              Results for <span className="text-clay-500">&ldquo;{term}&rdquo;</span>
            </>
          ) : (
            "Search"
          )}
        </h1>
      </header>

      {term === "" ? (
        <div className="border-t border-ink-200 pt-6">
          <EmptyState
            icon="search"
            title="What are you looking for?"
            description="Search by product, brand, category or even material — try “linen” or “sneakers”."
          />

          <PopularSearches className="pb-8" />
        </div>
      ) : (
        /*
         * Keyed on the term so a new search remounts the listing rather than
         * reusing the previous result set's state.
         */
        <ProductListing
          key={term}
          basePath="/search"
          locked={{ query: term }}
          facetScope={{ query: term }}
          emptyTitle={`No results for “${term}”`}
          emptyDescription="Check the spelling, try a broader word, or browse the full catalogue."
          emptyExtra={<PopularSearches title="Try a popular search" className="pb-8" />}
        />
      )}
    </div>
  );
}
