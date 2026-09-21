"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Loader2, Search, TrendingUp } from "lucide-react";

import { ProductImage } from "@/components/common/ProductImage";
import { Drawer } from "@/components/ui/Dialog";
import { Price } from "@/components/ui/Price";
import { useSearchSuggestions } from "@/hooks/useSearch";
import { humanize } from "@/lib/utils/format";
import { POPULAR_SEARCHES } from "@/services/searchService";

/**
 * Search, as a sheet from the top of the page.
 *
 * Suggestions are debounced and show products, matching categories and
 * matching brands, so a shopper can jump straight to an item or widen to a
 * department. Submitting goes to `/search?q=`, which is a real, linkable page
 * with the full filter and sort toolbar.
 */
export function SearchOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Search products"
      hideTitle
      side="bottom"
      className="inset-x-0 top-0 bottom-auto max-h-[90dvh] rounded-none rounded-b-[1rem] data-[state=closed]:animate-[dcz-slide-out-top_200ms_var(--ease-brand)] data-[state=open]:animate-[dcz-slide-in-top_280ms_var(--ease-brand)]"
    >
      {/*
        The body is its own component, so Radix unmounting the drawer on close
        clears the query for free — reopening always starts fresh without a
        reset effect.
      */}
      <SearchBody onClose={() => onOpenChange(false)} />
    </Drawer>
  );
}

function SearchBody({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [term, setTerm] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { suggestions, isSearching } = useSearchSuggestions(term);

  // Focus the field once the drawer has finished animating in.
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  const go = (destination: string) => {
    onClose();
    router.push(destination);
  };

  const submitSearch = () => {
    const trimmed = term.trim();
    if (!trimmed) return;
    go(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    submitSearch();
  };

  const hasResults = suggestions.products.length > 0;
  const showEmpty = term.trim().length >= 2 && !isSearching && !hasResults;

  return (
    <div className="page-shell py-5">
        <form onSubmit={onSubmit} role="search">
          <label htmlFor="site-search" className="sr-only">
            Search for products, brands and categories
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              id="site-search"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search for products, brands and more"
              autoComplete="off"
              className="h-12 w-full rounded-control border border-ink-200 bg-shell pl-11 pr-11 text-[0.9375rem] text-ink placeholder:text-ink-400 focus:border-copper-500"
            />
            {isSearching ? (
              <Loader2
                className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-400"
                strokeWidth={1.5}
                aria-hidden="true"
              />
            ) : null}
          </div>
        </form>

        {/* --------------------------------------------- nothing typed yet */}
        {term.trim().length < 2 ? (
          <div className="mt-6">
            <p className="label-wide mb-3 flex items-center gap-2 text-ink-500">
              <TrendingUp className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              Popular searches
            </p>
            <ul className="flex flex-wrap gap-2">
              {POPULAR_SEARCHES.map((popular) => (
                <li key={popular}>
                  <button
                    type="button"
                    onClick={() => go(`/search?q=${encodeURIComponent(popular)}`)}
                    className="rounded-pill border border-ink-200 px-3.5 py-1.5 text-sm text-ink-700 transition-colors hover:border-ink hover:text-ink"
                  >
                    {popular}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* -------------------------------------------------- no matches */}
        {showEmpty ? (
          <div className="mt-8 pb-4 text-center">
            <p className="font-display text-lg text-ink">
              No matches for &ldquo;{term.trim()}&rdquo;
            </p>
            <p className="mt-1.5 text-sm text-ink-500">
              Check the spelling, or try a broader word like &ldquo;shirt&rdquo; or
              &ldquo;bag&rdquo;.
            </p>
          </div>
        ) : null}

        {/* ---------------------------------------------------- suggestions */}
        {hasResults ? (
          <div className="mt-6 grid gap-6 pb-4 lg:grid-cols-[1fr_16rem]">
            <div>
              <p className="label-wide mb-3 text-ink-500">Products</p>
              <ul className="flex flex-col divide-y divide-ink-100">
                {suggestions.products.map((product) => (
                  <li key={product.id}>
                    <Link
                      href={`/product/${product.slug}`}
                      onClick={onClose}
                      className="flex items-center gap-3.5 py-2.5 transition-colors hover:bg-cream-deep"
                    >
                      <ProductImage
                        src={product.images[0]}
                        alt=""
                        sizes="56px"
                        wrapperClassName="h-16 w-14 shrink-0 rounded-card"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{product.name}</span>
                        <span className="mt-0.5 block text-xs text-ink-400">
                          {product.brand} &middot; {humanize(product.subcategory)}
                        </span>
                      </span>
                      <Price
                        price={product.price}
                        originalPrice={product.originalPrice}
                        size="sm"
                        showDiscount={false}
                        className="shrink-0"
                      />
                    </Link>
                  </li>
                ))}
              </ul>

              <button
                type="button"
                onClick={submitSearch}
                className="mt-4 border-b border-ink pb-0.5 label-wide text-ink transition-colors hover:border-copper-600 hover:text-copper-700"
              >
                See all {suggestions.total} results
              </button>
            </div>

            <div className="flex flex-col gap-6">
              {suggestions.categories.length > 0 ? (
                <div>
                  <p className="label-wide mb-3 text-ink-500">Categories</p>
                  <ul className="flex flex-col gap-2">
                    {suggestions.categories.map((category) => (
                      <li key={category}>
                        <Link
                          href={`/category/${category}`}
                          onClick={onClose}
                          className="text-sm text-ink-700 transition-colors hover:text-ink"
                        >
                          {humanize(category)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {suggestions.brands.length > 0 ? (
                <div>
                  <p className="label-wide mb-3 text-ink-500">Brands</p>
                  <ul className="flex flex-col gap-2">
                    {suggestions.brands.map((brand) => (
                      <li key={brand}>
                        <Link
                          href={`/shop?brand=${encodeURIComponent(brand)}`}
                          onClick={onClose}
                          className="text-sm text-ink-700 transition-colors hover:text-ink"
                        >
                          {brand}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
    </div>
  );
}
