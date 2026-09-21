import type { HomeSection, HomeSectionSource, Product } from "@/types";

import { ProductRail } from "@/components/products/ProductRail";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { TrustStrip } from "@/components/layout/TrustStrip";
import {
  getFeaturedCategories,
  getFeaturedCollections,
} from "@/services/categoryService";
import {
  getBestSellingProducts,
  getDeals,
  getFeaturedProducts,
  getNewArrivals,
  getTrendingProducts,
} from "@/services/productService";
import { getSiteConfig } from "@/services/siteService";

import { CategoryGrid } from "./CategoryGrid";
import { CollectionGrid } from "./CollectionGrid";
import { EditorialSplit } from "./EditorialSplit";
import { RecommendedRail } from "./RecommendedRail";

/**
 * Turns one `homepage.json` entry into rendered output.
 *
 * This is the whole reason the homepage is config-driven: `source` names a
 * merchandising query, and the map below is the only place that knows how to
 * run it. Adding a rail means adding a line to the JSON; adding a *kind* of
 * rail means adding a case here.
 */

const RAIL_SOURCES: Record<HomeSectionSource, (limit: number) => Promise<Product[]>> = {
  new: getNewArrivals,
  trending: getTrendingProducts,
  bestsellers: getBestSellingProducts,
  featured: getFeaturedProducts,
  deals: getDeals,
  // Resolved on the client — see the `recommended` branch below.
  recommended: async () => [],
};

export async function HomeSectionRenderer({ section }: { section: HomeSection }) {
  switch (section.type) {
    case "product-rail": {
      // Recommendations depend on local browsing history, so that rail is a
      // client island; every other rail is fetched and rendered here.
      if (section.source === "recommended") {
        return (
          <section aria-labelledby={`${section.id}-heading`} className="page-shell">
            <SectionHeader
              id={`${section.id}-heading`}
              title={section.title}
              subtitle={section.subtitle}
              viewAllHref={section.viewAllHref}
              className="mb-7"
            />
            <RecommendedRail limit={section.limit} layout={section.layout ?? "grid"} />
          </section>
        );
      }

      const products = await RAIL_SOURCES[section.source](section.limit);
      if (products.length === 0) return null;

      return (
        <section aria-labelledby={`${section.id}-heading`} className="page-shell">
          <SectionHeader
            id={`${section.id}-heading`}
            title={section.title}
            subtitle={section.subtitle}
            viewAllHref={section.viewAllHref}
            className="mb-7"
          />
          <ProductRail products={products} layout={section.layout ?? "grid"} />
        </section>
      );
    }

    case "category-grid": {
      const categories = await getFeaturedCategories(section.limit);
      if (categories.length === 0) return null;

      return (
        <section aria-labelledby={`${section.id}-heading`} className="page-shell">
          <SectionHeader
            id={`${section.id}-heading`}
            title={section.title}
            subtitle={section.subtitle}
            className="mb-7"
          />
          <CategoryGrid categories={categories} />
        </section>
      );
    }

    case "collection-grid": {
      const collections = await getFeaturedCollections(section.limit);
      if (collections.length === 0) return null;

      return (
        <section aria-labelledby={`${section.id}-heading`} className="page-shell">
          <SectionHeader
            id={`${section.id}-heading`}
            title={section.title}
            subtitle={section.subtitle}
            className="mb-7"
          />
          <CollectionGrid collections={collections} />
        </section>
      );
    }

    case "editorial-split":
      return (
        <section className="page-shell">
          <EditorialSplit
            title={section.title}
            body={section.body}
            image={section.image}
            ctaLabel={section.ctaLabel}
            ctaHref={section.ctaHref}
            align={section.align}
          />
        </section>
      );

    case "trust-strip": {
      const config = await getSiteConfig();
      return (
        <section aria-label="Why shop with us" className="page-shell">
          <TrustStrip points={config.trustPoints} />
        </section>
      );
    }

    default:
      // Exhaustiveness guard: a new section type must be handled above.
      return null;
  }
}
