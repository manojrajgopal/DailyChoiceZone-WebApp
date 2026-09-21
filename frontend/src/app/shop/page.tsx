import type { Metadata } from "next";
import { Suspense } from "react";

import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { ProductGridSkeleton } from "@/components/ui/Skeleton";
import { ProductListing } from "@/components/products/ProductListing";

export const metadata: Metadata = {
  title: "Shop all",
  description:
    "Browse the full Daily Choice Zone catalogue — clothing, footwear, home, beauty, accessories and more. Filter by size, colour, brand, price and rating.",
  alternates: { canonical: "/shop" },
};

/**
 * The full catalogue.
 *
 * `ProductListing` reads filters from the URL via `useSearchParams`, so it
 * sits behind a Suspense boundary — that is what lets the shell around it
 * stay statically rendered.
 */
export default function ShopPage() {
  return (
    <div className="page-shell py-8 sm:py-10">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Shop all" }]} />

      <header className="mt-4 mb-8 max-w-2xl">
        <h1 className="font-display text-[1.75rem] leading-tight text-ink sm:text-4xl">
          Shop all
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-500">
          Everything in the store, in one place. Narrow it down by department, size, colour or
          price — the filters update the link, so you can share exactly what you are looking at.
        </p>
      </header>

      <Suspense fallback={<ProductGridSkeleton count={12} />}>
        <ProductListing basePath="/shop" />
      </Suspense>
    </div>
  );
}
