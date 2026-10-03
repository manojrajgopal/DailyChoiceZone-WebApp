"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Clock, Loader2, Search, Sparkles, TrendingUp } from "lucide-react";

import { ProductImage } from "@/components/common/ProductImage";
import { Drawer } from "@/components/ui/Dialog";
import { Price } from "@/components/ui/Price";
import { usePopularSearches, useSearchSuggestions } from "@/hooks/useSearch";
import { useSiteContent } from "@/hooks/useSiteContent";
import { addRecentSearch, clearRecentSearches, readRecentSearches } from "@/lib/search/recent-searches";
import { cn } from "@/lib/utils/cn";
import type { SuggestedProduct } from "@/types";

/**
 * Search, as a sheet from the top of the page.
 *
 * As you type (debounced, stale requests aborted): products, categories and
 * brands from `GET /search/suggest`, with "Did you mean" when the server had
 * to correct the term. Before you type: your recent searches (this browser
 * only) and the store's popular ones. Submitting goes to `/search?q=`, a
 * real, linkable page with the full filter and sort toolbar.
 *
 * The field is an ARIA combobox: arrow keys move through every suggestion,
 * Enter opens the highlighted one (or searches), Escape closes.
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

type ItemKind = "correction" | "product" | "category" | "brand" | "all" | "recent" | "popular";

interface Item {
  kind: ItemKind;
  key: string;
  label: string;
  href: string;
  /** The term a search item searches for (recorded as a recent search). */
  term?: string;
  product?: SuggestedProduct;
}

interface OptionProps {
  id: string;
  role: "option";
  "aria-selected": boolean;
  tabIndex: number;
  onMouseEnter: () => void;
  "data-active": "true" | undefined;
}

const searchHref = (term: string) => `/search?q=${encodeURIComponent(term)}`;

export function SearchBody({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const [term, setTerm] = useState("");
  const [active, setActive] = useState<{ term: string; index: number }>({ term: "", index: -1 });
  const [recent, setRecent] = useState<string[]>(() => readRecentSearches());
  const inputRef = useRef<HTMLInputElement>(null);

  const trimmed = term.trim();
  const typing = trimmed.length >= 2;
  const { suggestions, isSearching } = useSearchSuggestions(term);
  const fallbackPopular = useSiteContent()?.popularSearches ?? [];
  const popular = usePopularSearches(fallbackPopular);

  // Focus the field once the drawer has finished animating in.
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  /* ------------------------------------------------- the option list */

  const correction = typing ? suggestions.correctedTerm : null;
  const items: Item[] = [];
  if (typing) {
    if (correction) {
      items.push({
        kind: "correction",
        key: `c:${correction}`,
        label: correction,
        href: searchHref(correction),
        term: correction,
      });
    }
    suggestions.products.forEach((product) =>
      items.push({
        kind: "product",
        key: `p:${product.id}`,
        label: product.name,
        href: `/product/${encodeURIComponent(product.id)}`,
        product,
      }),
    );
    suggestions.categories.forEach((category) =>
      items.push({
        kind: "category",
        key: `cat:${category.slug}`,
        label: category.name,
        href: `/category/${encodeURIComponent(category.slug)}`,
      }),
    );
    suggestions.brands.forEach((brand) =>
      items.push({
        kind: "brand",
        key: `b:${brand.value}`,
        label: brand.label || brand.value,
        href: `/shop?brand=${encodeURIComponent(brand.value)}`,
      }),
    );
    if (items.length > 0) {
      items.push({ kind: "all", key: "all", label: trimmed, href: searchHref(trimmed), term: trimmed });
    }
  } else {
    recent.forEach((entry) =>
      items.push({ kind: "recent", key: `r:${entry}`, label: entry, href: searchHref(entry), term: entry }),
    );
    popular
      .filter((entry) => !recent.some((r) => r.toLowerCase() === entry.toLowerCase()))
      .forEach((entry) =>
        items.push({ kind: "popular", key: `pop:${entry}`, label: entry, href: searchHref(entry), term: entry }),
      );
  }

  // The highlight belongs to the term it was made for, so typing resets it.
  const activeIndex = active.term === term && active.index < items.length ? active.index : -1;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const expanded = items.length > 0;

  /* ----------------------------------------------------------- actions */

  const remember = (searched?: string) => {
    if (searched) setRecent(addRecentSearch(searched));
  };

  const go = (destination: string, searched?: string) => {
    remember(searched);
    onClose();
    router.push(destination);
  };

  const submitSearch = () => {
    if (!trimmed) return;
    go(searchHref(trimmed), trimmed);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (items.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        activeIndex === -1
          ? step === 1
            ? 0
            : items.length - 1
          : (activeIndex + step + items.length) % items.length;
      setActive({ term, index: next });
      document.getElementById(optionId(next))?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = activeIndex >= 0 ? items[activeIndex] : undefined;
      if (item) go(item.href, item.term);
      else submitSearch();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const optionProps = (item: Item): OptionProps => {
    const index = items.indexOf(item);
    return {
      id: optionId(index),
      role: "option",
      "aria-selected": index === activeIndex,
      tabIndex: -1,
      onMouseEnter: () => setActive({ term, index }),
      "data-active": index === activeIndex ? "true" : undefined,
    };
  };

  const byKind = (...kinds: ItemKind[]) => items.filter((item) => kinds.includes(item.kind));
  const showEmpty = typing && !isSearching && items.length === 0;

  /* ------------------------------------------------------------ render */

  return (
    <div className="page-shell py-5">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
        role="search"
      >
        <label htmlFor={`${baseId}-input`} className="sr-only">
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
            id={`${baseId}-input`}
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={listboxId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search for products, brands and more"
            autoComplete="off"
            maxLength={100}
            className="h-12 w-full rounded-control border border-ink-200 bg-shell pl-11 pr-11 text-[0.9375rem] text-ink placeholder:text-ink-400 focus:border-copper-500"
          />
          {isSearching ? (
            <Loader2
              className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-400"
              strokeWidth={1.5}
              aria-label="Searching"
            />
          ) : null}
        </div>
      </form>

      <p className="sr-only" aria-live="polite">
        {typing && !isSearching
          ? items.length > 0
            ? `${items.length} suggestions available.`
            : `No suggestions for ${trimmed}.`
          : ""}
      </p>

      {showEmpty ? (
        <div className="mt-8 pb-4 text-center">
          <p className="font-display text-lg text-ink">No matches for &ldquo;{trimmed}&rdquo;</p>
          <p className="mt-1.5 text-sm text-ink-500">
            Check the spelling, or press Enter to search the whole catalogue.
          </p>
        </div>
      ) : null}

      {/* Outside the listbox: a listbox may only contain options. */}
      {!typing && recent.length > 0 ? (
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={() => {
              clearRecentSearches();
              setRecent([]);
              inputRef.current?.focus();
            }}
            className="text-xs text-ink-500 underline transition-colors hover:text-ink"
          >
            Clear recent searches
          </button>
        </div>
      ) : null}

      <div
        id={listboxId}
        role="listbox"
        aria-label="Search suggestions"
        className={cn("pb-4", !typing && recent.length > 0 ? "mt-2" : "mt-6")}
      >
        {/* --------------------------------------------- nothing typed yet */}
        {!typing ? (
          <div className="flex flex-col gap-6">
            {byKind("recent").length > 0 ? (
              <Group
                id={`${baseId}-recent`}
                title="Recent searches"
                icon={<Clock className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />}
              >
                <div className="flex flex-wrap gap-2">
                  {byKind("recent").map((item) => (
                    <Chip key={item.key} item={item} props={optionProps(item)} onPick={() => remember(item.term)} onClose={onClose} />
                  ))}
                </div>
              </Group>
            ) : null}

            {byKind("popular").length > 0 ? (
              <Group
                id={`${baseId}-popular`}
                title="Popular searches"
                icon={<TrendingUp className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />}
              >
                <div className="flex flex-wrap gap-2">
                  {byKind("popular").map((item) => (
                    <Chip key={item.key} item={item} props={optionProps(item)} onPick={() => remember(item.term)} onClose={onClose} />
                  ))}
                </div>
              </Group>
            ) : null}
          </div>
        ) : null}

        {/* ---------------------------------------------------- suggestions */}
        {typing && items.length > 0 ? (
          <div className="flex flex-col gap-6">
            {byKind("correction").map((item) => (
              <Group key={item.key} id={`${baseId}-correction`} title="Did you mean" icon={<Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />}>
                <Link
                  href={item.href}
                  onClick={() => {
                    remember(item.term);
                    onClose();
                  }}
                  {...optionProps(item)}
                  className={optionClass(item, items, activeIndex, "text-sm text-ink")}
                >
                  Did you mean <span className="font-medium text-clay-500">&ldquo;{item.label}&rdquo;</span>?
                </Link>
              </Group>
            ))}

            <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
              <div>
                {byKind("product").length > 0 ? (
                  <Group id={`${baseId}-products`} title="Products">
                    <div className="flex flex-col divide-y divide-ink-100">
                      {byKind("product").map((item) => (
                        <Link
                          key={item.key}
                          href={item.href}
                          onClick={onClose}
                          {...optionProps(item)}
                          className={optionClass(item, items, activeIndex, "flex items-center gap-3.5 py-2.5")}
                        >
                          <ProductImage
                            src={item.product?.image || undefined}
                            alt=""
                            sizes="56px"
                            wrapperClassName="h-16 w-14 shrink-0 rounded-card"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-ink">{item.label}</span>
                            {item.product?.brand ? (
                              <span className="mt-0.5 block text-xs text-ink-400">{item.product.brand}</span>
                            ) : null}
                          </span>
                          {item.product ? (
                            <Price
                              price={item.product.price}
                              originalPrice={item.product.originalPrice}
                              size="sm"
                              showDiscount={false}
                              className="shrink-0"
                            />
                          ) : null}
                        </Link>
                      ))}
                    </div>
                  </Group>
                ) : null}

                {byKind("all").map((item) => (
                  <Link
                    key={item.key}
                    href={item.href}
                    onClick={() => {
                      remember(item.term);
                      onClose();
                    }}
                    {...optionProps(item)}
                    className={optionClass(
                      item,
                      items,
                      activeIndex,
                      "mt-4 inline-block border-b border-ink pb-0.5 label-wide text-ink hover:border-copper-600 hover:text-copper-700",
                    )}
                  >
                    See all results for &ldquo;{item.label}&rdquo;
                  </Link>
                ))}
              </div>

              <div className="flex flex-col gap-6">
                {byKind("category").length > 0 ? (
                  <Group id={`${baseId}-categories`} title="Categories">
                    <div className="flex flex-col gap-1">
                      {byKind("category").map((item) => (
                        <Link
                          key={item.key}
                          href={item.href}
                          onClick={onClose}
                          {...optionProps(item)}
                          className={optionClass(item, items, activeIndex, "py-1 text-sm text-ink-700 hover:text-ink")}
                        >
                          {item.label}
                        </Link>
                      ))}
                    </div>
                  </Group>
                ) : null}

                {byKind("brand").length > 0 ? (
                  <Group id={`${baseId}-brands`} title="Brands">
                    <div className="flex flex-col gap-1">
                      {byKind("brand").map((item) => (
                        <Link
                          key={item.key}
                          href={item.href}
                          onClick={onClose}
                          {...optionProps(item)}
                          className={optionClass(item, items, activeIndex, "py-1 text-sm text-ink-700 hover:text-ink")}
                        >
                          {item.label}
                        </Link>
                      ))}
                    </div>
                  </Group>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function optionClass(item: Item, items: Item[], activeIndex: number, base: string): string {
  return cn(
    base,
    "rounded-control outline-none transition-colors hover:bg-cream-deep",
    items.indexOf(item) === activeIndex && "bg-cream-deep ring-1 ring-copper-500",
  );
}

function Group({
  id,
  title,
  icon,
  children,
}: {
  id: string;
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-labelledby={id}>
      <p id={id} className="label-wide mb-3 flex items-center gap-2 text-ink-500">
        {icon}
        {title}
      </p>
      {children}
    </div>
  );
}

function Chip({
  item,
  props,
  onPick,
  onClose,
}: {
  item: Item;
  props: OptionProps;
  onPick: () => void;
  onClose: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={() => {
        onPick();
        onClose();
      }}
      {...props}
      className={cn(
        "inline-flex rounded-pill border border-ink-200 px-3.5 py-1.5 text-sm text-ink-700 outline-none transition-colors hover:border-ink hover:text-ink",
        props["aria-selected"] === true && "border-ink bg-cream-deep text-ink",
      )}
    >
      {item.label}
    </Link>
  );
}
