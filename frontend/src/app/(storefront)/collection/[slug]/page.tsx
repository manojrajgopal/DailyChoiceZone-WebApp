import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";

import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { ProductGrid } from "@/components/products/ProductGrid";
import { getCollectionWithProducts } from "@/services/categoryService";

interface PageProps {
  params: Promise<{ slug: string }>;
}

/**
 * Rendered per request, like every catalogue route — see the product page for
 * why. `notFound()` below still returns a genuine 404 for an unknown slug.
 */

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await getCollectionWithProducts(slug);

  if (!result) return { title: "Collection not found" };

  return {
    title: result.collection.name,
    description: result.collection.description,
    alternates: { canonical: `/collection/${result.collection.slug}` },
    openGraph: {
      title: `${result.collection.name} · Daily Choice Zone`,
      description: result.collection.description,
      images: [{ url: result.collection.image }],
    },
  };
}

/**
 * A curated collection.
 *
 * Unlike a category, membership here is an explicit, hand-picked list rather
 * than a query — so there is no filter rail. What you see is the edit.
 */
export default async function CollectionPage({ params }: PageProps) {
  const { slug } = await params;
  const result = await getCollectionWithProducts(slug);

  if (!result) notFound();

  const { collection, products } = result;

  return (
    <div className="pb-8">
      <div className="relative">
        <div className="relative h-52 w-full overflow-hidden sm:h-64 lg:h-80">
          <Image
            src={collection.image}
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-ink/80 via-ink/35 to-ink/10" />
        </div>

        <div className="page-shell absolute inset-x-0 bottom-0 pb-7">
          <p className="label-wide mb-2 text-copper-200">Collection</p>
          <h1 className="font-display text-3xl leading-tight text-cream sm:text-4xl">
            {collection.name}
          </h1>
          <p className="mt-2.5 max-w-2xl text-sm leading-relaxed text-cream/80">
            {collection.description}
          </p>
        </div>
      </div>

      <div className="page-shell pt-6">
        <Breadcrumb
          items={[
            { label: "Home", href: "/" },
            { label: "Shop all", href: "/shop" },
            { label: collection.name },
          ]}
        />

        <p className="mt-6 border-b border-ink-200 pb-4 text-sm text-ink-500 tabular-nums">
          <span className="font-medium text-ink">{products.length}</span>{" "}
          {products.length === 1 ? "piece" : "pieces"} in this collection
        </p>

        <div className="pt-8">
          <ProductGrid products={products} prioritiseFirstRow />
        </div>
      </div>
    </div>
  );
}
