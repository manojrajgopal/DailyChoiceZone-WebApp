import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { ProductGallery } from "@/components/products/ProductGallery";
import { ProductPurchasePanel } from "@/components/products/ProductPurchasePanel";
import { ProductRail } from "@/components/products/ProductRail";
import { ProductReviews } from "@/components/products/ProductReviews";
import { RecentlyViewedRail } from "@/components/products/RecentlyViewedRail";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Tabs } from "@/components/ui/Tabs";
import { getProductBySlug, getProducts, getRelatedProducts } from "@/services/productService";
import { getReviewSummary, getReviews } from "@/services/reviewService";
import { getSiteConfig } from "@/services/siteService";
import { formatPrice, humanize } from "@/lib/utils/format";

interface PageProps {
  params: Promise<{ slug: string }>;
}

/**
 * Every valid slug is known at build time, so anything else is genuinely not
 * found.
 *
 * Without this, Next renders unknown slugs on demand and serves the not-found
 * page with a 200 status — a "soft 404" that lets search engines index
 * unlimited junk URLs. `dynamicParams = false` returns a real 404 instead. The
 * catalogue is bundled JSON, so a new product needs a rebuild regardless and
 * nothing is lost by declaring the set closed.
 */
export const dynamicParams = false;

/**
 * Pre-render every product.
 *
 * The catalogue is small enough that this is worth it — the static pages cost
 * little and every product page then serves instantly. With a catalogue in the
 * tens of thousands this would switch to on-demand rendering with a cache.
 */
export async function generateStaticParams() {
  const { items } = await getProducts({ pageSize: 500, page: 1 });
  return items.map((product) => ({ slug: product.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product) return { title: "Product not found" };

  const title = `${product.name} — ${product.brand}`;
  const description = product.description.slice(0, 160);

  return {
    title,
    description,
    alternates: { canonical: `/product/${product.slug}` },
    openGraph: {
      type: "website",
      title,
      description,
      images: product.images.slice(0, 1).map((url) => ({ url })),
    },
    other: {
      // Genuine product facts, not keyword padding.
      "product:price:amount": String(product.price),
      "product:price:currency": product.currency,
      "product:availability": product.stock > 0 ? "in stock" : "out of stock",
    },
  };
}

export default async function ProductPage({ params }: PageProps) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);

  if (!product) notFound();

  const [related, reviews, summary, config] = await Promise.all([
    getRelatedProducts(product.id, 6),
    getReviews(product.id),
    getReviewSummary(product.id),
    getSiteConfig(),
  ]);

  /**
   * Product structured data.
   *
   * Real values only — price, availability and the aggregate of the reviews
   * actually shown on the page. Search engines penalise ratings that do not
   * match visible content, and rightly so.
   */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.description,
    sku: product.sku,
    image: product.images,
    brand: { "@type": "Brand", name: product.brand },
    material: product.material,
    offers: {
      "@type": "Offer",
      price: product.price,
      priceCurrency: product.currency,
      availability:
        product.stock > 0
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
    },
    ...(summary.total > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: summary.average,
            reviewCount: summary.total,
          },
        }
      : {}),
  };

  return (
    <div className="pb-8">
      <script
        type="application/ld+json"
        // Serialising our own data, and `<` is escaped to close the injection
        // vector that dangerouslySetInnerHTML otherwise leaves open.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />

      <div className="page-shell py-6">
        <Breadcrumb
          items={[
            { label: "Home", href: "/" },
            { label: humanize(product.category), href: `/category/${product.category}` },
            {
              label: humanize(product.subcategory),
              href: `/category/${product.category}?subcategory=${product.subcategory}`,
            },
            { label: product.name },
          ]}
        />

        {/* ---------------------------------------------- gallery + buy box */}
        <div className="mt-6 grid gap-8 lg:grid-cols-2 lg:gap-14">
          <ProductGallery images={product.images} name={product.name} />
          <ProductPurchasePanel product={product} config={config} />
        </div>

        {/* ----------------------------------------------------- detail tabs */}
        <div className="mt-16 max-w-4xl">
          <Tabs
            tabs={[
              {
                id: "details",
                label: "Details",
                content: (
                  <div className="flex flex-col gap-5">
                    <p className="max-w-prose text-sm leading-relaxed text-ink-700">
                      {product.description}
                    </p>

                    <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
                      {product.specifications.map((spec) => (
                        <div
                          key={spec.label}
                          className="flex justify-between gap-4 border-b border-ink-100 pb-2.5"
                        >
                          <dt className="text-xs text-ink-400">{spec.label}</dt>
                          <dd className="text-right text-xs text-ink-700">{spec.value}</dd>
                        </div>
                      ))}
                      {product.colors.length > 0 ? (
                        <div className="flex justify-between gap-4 border-b border-ink-100 pb-2.5">
                          <dt className="text-xs text-ink-400">Colours</dt>
                          <dd className="text-right text-xs text-ink-700">
                            {product.colors.map((color) => color.name).join(", ")}
                          </dd>
                        </div>
                      ) : null}
                      {product.sizes.length > 0 ? (
                        <div className="flex justify-between gap-4 border-b border-ink-100 pb-2.5">
                          <dt className="text-xs text-ink-400">Sizes</dt>
                          <dd className="text-right text-xs text-ink-700">
                            {product.sizes.join(", ")}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                ),
              },
              {
                id: "care",
                label: "Material & care",
                content: (
                  <div className="flex max-w-prose flex-col gap-4 text-sm leading-relaxed text-ink-700">
                    <p>
                      <span className="font-medium text-ink">Material:</span> {product.material}
                    </p>
                    <p>
                      <span className="font-medium text-ink">Care:</span> {product.care}
                    </p>
                    <p className="text-ink-500">
                      Following the care instructions is the single biggest factor in how long a
                      piece lasts. When in doubt, wash cooler and dry flat.
                    </p>
                  </div>
                ),
              },
              {
                id: "delivery",
                label: "Delivery & returns",
                content: (
                  <div className="flex max-w-prose flex-col gap-4 text-sm leading-relaxed text-ink-700">
                    <p>
                      Standard delivery takes 3–5 business days and is free on orders above{" "}
                      {formatPrice(config.freeDeliveryThreshold)}. Below that it is{" "}
                      {formatPrice(config.standardDeliveryFee)}. Express delivery arrives in 1–2
                      business days.
                    </p>
                    <p>
                      Returns are accepted within {config.returnWindowDays} days of delivery, as
                      long as the item is unworn with its tags attached. We arrange the pickup and
                      refund to the original payment method within 5–7 business days of the item
                      reaching us.
                    </p>
                    <p className="text-ink-500">
                      Questions? Reach us at {config.support.email} or {config.support.phone},{" "}
                      {config.support.hours}.
                    </p>
                  </div>
                ),
              },
            ]}
          />
        </div>

        {/* --------------------------------------------------------- reviews */}
        <section id="reviews" aria-labelledby="reviews-heading" className="mt-16 scroll-mt-28">
          <SectionHeader
            id="reviews-heading"
            title="Customer reviews"
            subtitle="What people say"
            className="mb-8"
          />
          <ProductReviews productId={product.id} reviews={reviews} summary={summary} />
        </section>
      </div>

      {/* ------------------------------------------------ related + history */}
      <div className="mt-16 flex flex-col gap-16">
        {related.length > 0 ? (
          <section aria-labelledby="related-heading" className="page-shell">
            <SectionHeader
              id="related-heading"
              title="You may also like"
              subtitle="Similar pieces"
              viewAllHref={`/category/${product.category}?subcategory=${product.subcategory}`}
              className="mb-7"
            />
            <ProductRail products={related} layout="rail" />
          </section>
        ) : null}

        <RecentlyViewedRail recordId={product.id} excludeId={product.id} />
      </div>
    </div>
  );
}
