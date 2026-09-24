import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";

import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { ProductGridSkeleton } from "@/components/ui/Skeleton";
import { ProductListing } from "@/components/products/ProductListing";
import { getCategoryBySlug } from "@/services/categoryService";

interface PageProps {
  params: Promise<{ slug: string }>;
}

/**
 * Rendered per request, like every catalogue route — see the product page for
 * why. `notFound()` below still returns a genuine 404 for an unknown slug.
 */

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);

  if (!category) return { title: "Category not found" };

  return {
    title: category.name,
    description: category.description,
    alternates: { canonical: `/category/${category.slug}` },
    openGraph: {
      title: `${category.name} · Daily Choice Zone`,
      description: category.description,
      images: [{ url: category.image }],
    },
  };
}

/**
 * A category landing page.
 *
 * It reuses `ProductListing` with the category locked, so the filters, sort
 * and pagination behave exactly as on /shop — the only difference is that the
 * category cannot be unticked, because the route is the category.
 */
export default async function CategoryPage({ params }: PageProps) {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);

  if (!category) notFound();

  const subcategories = category.groups.flatMap((group) => group.items);

  return (
    <div className="pb-8">
      {/* ------------------------------------------------ category banner */}
      <div className="relative">
        <div className="relative h-44 w-full overflow-hidden sm:h-56 lg:h-64">
          <Image
            src={category.image}
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-ink/75 via-ink/30 to-ink/10" />
        </div>

        <div className="page-shell absolute inset-x-0 bottom-0 pb-6">
          <h1 className="font-display text-3xl leading-tight text-cream sm:text-4xl">
            {category.name}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-cream/80">
            {category.description}
          </p>
        </div>
      </div>

      <div className="page-shell pt-6">
        <Breadcrumb
          items={[
            { label: "Home", href: "/" },
            { label: "Shop all", href: "/shop" },
            { label: category.name },
          ]}
        />

        {/* --------------------------------------------- subcategory pills */}
        {subcategories.length > 1 ? (
          <nav aria-label={`${category.name} product types`} className="mt-5">
            <ul className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
              {subcategories.map((subcategory) => (
                <li key={subcategory.slug} className="shrink-0">
                  <Link
                    href={`/category/${category.slug}?subcategory=${subcategory.slug}`}
                    className="inline-flex rounded-pill border border-ink-200 bg-shell px-4 py-2 text-sm text-ink-700 transition-colors hover:border-ink hover:text-ink"
                  >
                    {subcategory.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <div className="mt-8">
          <Suspense fallback={<ProductGridSkeleton count={12} />}>
            <ProductListing
              basePath={`/category/${category.slug}`}
              locked={{ category: [category.slug] }}
              showCategoryFilter={false}
              facetScope={{ category: [category.slug] }}
              emptyTitle={`Nothing in ${category.name} matches those filters`}
              emptyDescription="Try removing a filter, or browse the whole department."
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
