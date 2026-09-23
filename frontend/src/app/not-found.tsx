import type { Metadata } from "next";
import Link from "next/link";

import { Footer } from "@/components/layout/Footer";
import { PromoStrip } from "@/components/layout/PromoStrip";
import { Header } from "@/components/navigation/Header";
import { ButtonLink } from "@/components/ui/Button";
import { getFeaturedCategories } from "@/services/categoryService";
import { getBanners, getNavigation, getSiteConfig } from "@/services/siteService";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

/**
 * The global 404, for URLs that match no route at all.
 *
 * It renders the storefront chrome itself rather than inheriting it: this file
 * sits at the app root, outside the `(storefront)` group, so the header and
 * footer are not applied for it. A shopper landing on a bad link should still
 * arrive somewhere that looks like the shop, with a way back into it.
 */
export default async function NotFound() {
  const [config, banners, categories] = await Promise.all([
    getSiteConfig(),
    getBanners(),
    getFeaturedCategories(6),
  ]);
  const navigation = getNavigation();

  return (
    <div className="flex min-h-dvh flex-col bg-cream text-ink">
      <PromoStrip banners={banners} />
      <Header items={navigation} />

      <main className="flex-1">
        <div className="page-shell flex flex-col items-center py-20 text-center sm:py-28">
          <p className="font-display text-5xl text-copper-300 tabular-nums sm:text-6xl">404</p>

          <h1 className="mt-6 font-display text-2xl leading-tight text-ink sm:text-3xl">
            We could not find that page
          </h1>

          <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-500">
            The link may be out of date, or the product may no longer be in the range. Everything
            below still is.
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-2.5">
            <ButtonLink href="/shop">Shop all products</ButtonLink>
            <ButtonLink href="/" variant="outline">
              Back to home
            </ButtonLink>
          </div>

          {categories.length > 0 ? (
            <nav aria-label="Departments" className="mt-12 w-full max-w-lg">
              <p className="label-wide mb-4 text-ink-400">Or jump to a department</p>
              <ul className="flex flex-wrap justify-center gap-2">
                {categories.map((category) => (
                  <li key={category.id}>
                    <Link
                      href={`/category/${category.slug}`}
                      className="inline-flex rounded-pill border border-ink-200 px-3.5 py-1.5 text-sm text-ink-700 transition-colors hover:border-ink hover:text-ink"
                    >
                      {category.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </div>
      </main>

      <Footer config={config} />
    </div>
  );
}
