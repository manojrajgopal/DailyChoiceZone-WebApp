import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display } from "next/font/google";

import { Footer } from "@/components/layout/Footer";
import { PromoStrip } from "@/components/layout/PromoStrip";
import { Header } from "@/components/navigation/Header";
import { Toaster } from "@/components/ui/Toaster";
import { getBanners, getNavigation, getSiteConfig } from "@/services/siteService";

import "./globals.css";

/**
 * The brand pairs a high-contrast serif with a quiet grotesque — the same
 * relationship the logo strikes between "Daily Choice" and "ZONE".
 */
const playfair = Playfair_Display({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-playfair",
});

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export async function generateMetadata(): Promise<Metadata> {
  const config = await getSiteConfig();

  return {
    // "%s · Daily Choice Zone" on every child page, without repeating it.
    title: {
      default: `${config.name} — ${config.tagline}`,
      template: `%s · ${config.name}`,
    },
    description: config.description,
    metadataBase: new URL(config.url),
    applicationName: config.name,
    openGraph: {
      type: "website",
      siteName: config.name,
      title: `${config.name} — ${config.tagline}`,
      description: config.description,
      locale: "en_IN",
    },
    twitter: { card: "summary_large_image" },
    robots: { index: true, follow: true },
  };
}

export const viewport: Viewport = {
  themeColor: "#faf7f2",
  colorScheme: "light",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Chrome data is fetched once here rather than per page.
  const [config, banners] = await Promise.all([getSiteConfig(), getBanners()]);
  const navigation = getNavigation();

  return (
    <html lang="en-IN" className={`${playfair.variable} ${inter.variable}`}>
      <body className="flex min-h-dvh flex-col">
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
        <Toaster />
      </body>
    </html>
  );
}
