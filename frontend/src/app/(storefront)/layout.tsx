import { Footer } from "@/components/layout/Footer";
import { PromoStrip } from "@/components/layout/PromoStrip";
import { Header } from "@/components/navigation/Header";
import { getBanners, getNavigation, getSiteConfig } from "@/services/siteService";

/**
 * The customer-facing chrome.
 *
 * Everything a shopper sees is inside this route group, which is what keeps the
 * promo strip, header and footer out of `/admin`. The group's name is in
 * parentheses, so it contributes nothing to any URL — `/shop` is still `/shop`.
 */
export default async function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Chrome data is fetched once here rather than per page.
  const [config, banners] = await Promise.all([getSiteConfig(), getBanners()]);
  const navigation = getNavigation();

  return (
    <div className="flex min-h-dvh flex-col bg-cream text-ink">
      {/* Keyboard users can jump the whole header and mega menu. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-control focus:bg-ink focus:px-4 focus:py-2.5 focus:label-wide focus:text-cream"
      >
        Skip to content
      </a>

      <PromoStrip banners={banners} />
      <Header items={navigation} />

      <main id="main" className="flex-1">
        {children}
      </main>

      <Footer config={config} />
    </div>
  );
}
