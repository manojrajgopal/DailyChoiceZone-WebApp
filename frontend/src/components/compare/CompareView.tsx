"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { GitCompareArrows, X } from "lucide-react";

import type { Product } from "@/types";

import { EmptyState } from "@/components/common/States";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { ProductImage } from "@/components/common/ProductImage";
import { Rating } from "@/components/ui/Rating";
import { Skeleton } from "@/components/ui/Skeleton";
import { COMPARE_LIMIT, useCompareProducts } from "@/hooks/useCompare";
import { productHref } from "@/lib/products/colourImages";
import { cn } from "@/lib/utils/cn";
import { humanize } from "@/lib/utils/format";

type Row = { key: string; label: string; values: (string | null)[]; render?: (product: Product) => React.ReactNode };

/**
 * Products side by side.
 *
 * Rows are built from what the products actually have: a specification only
 * one of them lists still appears (the others show "—"), but a row nobody has
 * a value for doesn't. Rows where the products differ are marked, and can be
 * shown on their own.
 *
 * On a phone, two products at a time, chosen from the list — a four-column
 * table at that width is a table nobody can read.
 */
export function CompareView() {
  const { products, loading, error, remove, clear } = useCompareProducts();
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const [pair, setPair] = useState<[number, number]>([0, 1]);

  const rows = useMemo(() => buildRows(products), [products]);
  const shown = onlyDifferences ? rows.filter((row) => differs(row.values)) : rows;

  // The two columns a phone shows, kept inside the list as it shrinks.
  const first = Math.min(pair[0], Math.max(0, products.length - 1));
  const second = products.length > 1 ? Math.min(pair[1] === first ? (first + 1) % products.length : pair[1], products.length - 1) : first;
  const visibleOnPhone = new Set(products.length > 1 ? [first, second] : [0]);

  return (
    <div className="page-shell py-8 sm:py-10">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Compare products" }]} />
      <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">Compare products</h1>
          <p className="mt-2 text-sm text-ink-500">
            Up to {COMPARE_LIMIT} products side by side. Add more from any product card or product page.
          </p>
        </div>
        {products.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink-700">
              <input
                type="checkbox"
                checked={onlyDifferences}
                onChange={(event) => setOnlyDifferences(event.target.checked)}
                className="h-4 w-4 accent-[var(--color-ink)]"
              />
              Show only differences
            </label>
            <Button variant="ghost" size="sm" onClick={() => void clear()}>
              Clear all
            </Button>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="flex flex-col gap-2.5">
              <Skeleton className="aspect-[3/4] w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : error ? (
        <EmptyState
          title="The comparison didn't load"
          description="Please check your connection and try again."
          action={{ label: "Keep shopping", href: "/shop" }}
          className="mt-6"
        />
      ) : products.length === 0 ? (
        <EmptyState
          title="Nothing to compare yet"
          description="Tap the compare icon on any product to add it here, then see them side by side."
          action={{ label: "Start shopping", href: "/shop" }}
          className="mt-6"
        />
      ) : (
        <>
          {products.length > 2 ? (
            <div className="mt-6 grid grid-cols-2 gap-3 md:hidden">
              {[0, 1].map((slot) => (
                <label key={slot} className="flex flex-col gap-1 text-xs text-ink-500">
                  {slot === 0 ? "Left" : "Right"}
                  <select
                    value={slot === 0 ? first : second}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setPair(slot === 0 ? [value, second === value ? first : second] : [first === value ? second : first, value]);
                    }}
                    className="h-10 rounded-card border border-ink-200 bg-shell px-2 text-sm text-ink"
                  >
                    {products.map((product, index) => (
                      <option key={product.id} value={index}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : null}

          <div className="mt-6 overflow-hidden rounded-card border border-ink-200 bg-shell">
            <div
              className="grid"
              style={{ gridTemplateColumns: `minmax(0,1fr)` }}
              role="table"
              aria-label="Product comparison"
            >
              {/* Header: the products */}
              <div role="row" className={gridClass(products.length)}>
                <div role="columnheader" className="hidden border-b border-ink-100 p-4 md:block">
                  <span className="sr-only">Feature</span>
                  <GitCompareArrows className="h-5 w-5 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
                </div>
                {products.map((product, index) => (
                  <div
                    key={product.id}
                    role="columnheader"
                    className={cn("relative border-b border-l border-ink-100 p-3 sm:p-4", !visibleOnPhone.has(index) && "hidden md:block")}
                  >
                    <button
                      type="button"
                      onClick={() => void remove(product.id)}
                      aria-label={`Remove ${product.name} from comparison`}
                      className="absolute right-2 top-2 z-[2] inline-flex h-7 w-7 items-center justify-center rounded-pill bg-shell/90 text-ink-500 shadow-subtle hover:text-ink"
                    >
                      <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                    <Link href={productHref(product)} className="block">
                      <ProductImage src={product.images[0]} alt="" wrapperClassName="aspect-[3/4] w-full" sizes="(min-width: 768px) 20vw, 45vw" />
                      <span className="mt-3 block text-sm leading-snug text-ink hover:text-copper-700">{product.name}</span>
                    </Link>
                    <span className="mt-0.5 block text-xs text-ink-500">{product.brand}</span>
                    <Price price={product.price} originalPrice={product.originalPrice} discount={product.discount} size="sm" className="mt-1.5" />
                    <ButtonLink href={productHref(product)} size="sm" variant="outline" className="mt-3 w-full">
                      {product.stock > 0 ? "View & buy" : "View"}
                    </ButtonLink>
                  </div>
                ))}
              </div>

              {shown.map((row) => {
                const different = differs(row.values);
                return (
                  <div key={row.key} role="row" className={cn(gridClass(products.length), different && "bg-copper-50/60")}>
                    <div
                      role="rowheader"
                      className="col-span-full flex items-center gap-2 border-b border-ink-100 px-3 pb-1 pt-3 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-ink-500 md:col-span-1 md:p-4 md:text-xs md:normal-case md:tracking-normal"
                    >
                      {row.label}
                      {different ? (
                        <span className="rounded-pill bg-copper-100 px-1.5 py-px text-[0.625rem] font-medium normal-case tracking-normal text-copper-800">
                          Differs
                        </span>
                      ) : null}
                    </div>
                    {products.map((product, index) => (
                      <div
                        key={product.id}
                        role="cell"
                        className={cn(
                          "border-b border-l border-ink-100 px-3 py-2.5 text-sm text-ink-700 md:p-4",
                          !visibleOnPhone.has(index) && "hidden md:block",
                        )}
                      >
                        {row.render ? row.render(product) : (row.values[index] ?? <span className="text-ink-300">—</span>)}
                      </div>
                    ))}
                  </div>
                );
              })}
              {shown.length === 0 ? (
                <p className="p-6 text-center text-sm text-ink-500">These products don&rsquo;t differ in anything listed here.</p>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Two columns on a phone (or one); the label column plus one per product from tablet up. */
function gridClass(count: number): string {
  const desktop = { 1: "md:grid-cols-[12rem_repeat(1,minmax(0,1fr))]", 2: "md:grid-cols-[12rem_repeat(2,minmax(0,1fr))]",
    3: "md:grid-cols-[12rem_repeat(3,minmax(0,1fr))]", 4: "md:grid-cols-[12rem_repeat(4,minmax(0,1fr))]" }[Math.min(4, Math.max(1, count)) as 1 | 2 | 3 | 4];
  return cn("grid", count > 1 ? "grid-cols-2" : "grid-cols-1", desktop);
}

function differs(values: (string | null)[]): boolean {
  return values.length > 1 && new Set(values.map((value) => (value ?? "").toLowerCase())).size > 1;
}

function yesNo(value: boolean | undefined): string | null {
  return value === undefined ? null : value ? "Yes" : "No";
}

function buildRows(products: Product[]): Row[] {
  if (products.length === 0) return [];
  const rows: Row[] = [
    {
      key: "price",
      label: "Price",
      values: products.map((p) => `₹${p.price}`),
      render: (p) => <Price price={p.price} originalPrice={p.originalPrice} discount={p.discount} size="sm" />,
    },
    { key: "discount", label: "Discount", values: products.map((p) => (p.discount > 0 ? `${p.discount}% off` : null)) },
    {
      key: "rating",
      label: "Rating",
      values: products.map((p) => (p.reviewCount > 0 ? `${p.rating}` : null)),
      render: (p) => (p.reviewCount > 0 ? <Rating value={p.rating} reviewCount={p.reviewCount} /> : <span className="text-ink-300">No reviews yet</span>),
    },
    { key: "availability", label: "Availability", values: products.map((p) => (p.stock > 0 ? "In stock" : "Sold out")) },
    { key: "category", label: "Category", values: products.map((p) => [humanize(p.category), humanize(p.subcategory)].filter(Boolean).join(" · ") || null) },
    { key: "brand", label: "Brand", values: products.map((p) => p.brand || null) },
    { key: "material", label: "Material", values: products.map((p) => p.material || null) },
    { key: "sizes", label: "Sizes", values: products.map((p) => (p.sizes.length ? p.sizes.join(", ") : null)) },
    { key: "colours", label: "Colours", values: products.map((p) => (p.colors.length ? p.colors.map((c) => c.name).join(", ") : null)) },
  ];
  // Every specification any of them lists, in the order first seen.
  const labels: string[] = [];
  for (const product of products) {
    for (const spec of product.specifications) {
      if (!labels.some((label) => label.toLowerCase() === spec.label.toLowerCase())) labels.push(spec.label);
    }
  }
  for (const label of labels) {
    rows.push({
      key: `spec-${label}`,
      label,
      values: products.map((p) => p.specifications.find((s) => s.label.toLowerCase() === label.toLowerCase())?.value ?? null),
    });
  }
  rows.push(
    { key: "returns", label: "Returnable", values: products.map((p) => yesNo(p.isReturnable)) },
    { key: "replace", label: "Replaceable", values: products.map((p) => yesNo(p.isReplaceable)) },
    { key: "care", label: "Care", values: products.map((p) => p.care || null) },
  );
  return rows.filter((row) => row.values.some((value) => value !== null && value !== ""));
}
