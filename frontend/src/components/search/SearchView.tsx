"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { EmptyState } from "@/components/common/States";
import { ProductListing } from "@/components/products/ProductListing";
import { POPULAR_SEARCHES } from "@/services/searchService";

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

          <div className="mx-auto max-w-lg pb-8">
            <p className="label-wide mb-3 text-center text-ink-500">Popular searches</p>
            <ul className="flex flex-wrap justify-center gap-2">
              {POPULAR_SEARCHES.map((popular) => (
                <li key={popular}>
                  <Link
                    href={`/search?q=${encodeURIComponent(popular)}`}
                    className="inline-flex rounded-pill border border-ink-200 px-3.5 py-1.5 text-sm text-ink-700 transition-colors hover:border-ink hover:text-ink"
                  >
                    {popular}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
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
        />
      )}
    </div>
  );
}
