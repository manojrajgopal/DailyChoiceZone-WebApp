import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display } from "next/font/google";

import { Toaster } from "@/components/ui/Toaster";
import { getSiteConfig } from "@/services/siteService";

import "./globals.css";

/**
 * The document shell.
 *
 * Deliberately thin: fonts, metadata and the toast surface, and nothing else.
 *
 * The storefront's header and footer live in `(storefront)/layout.tsx` rather
 * than here, because the admin portal must not render customer navigation —
 * and a parent layout cannot be opted out of. Route groups are how the two
 * areas get different chrome without changing a single URL.
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN" className={`${playfair.variable} ${inter.variable}`}>
      <body className="min-h-dvh">
        {children}
        {/* Mounted once for both areas — the admin uses the same toasts. */}
        <Toaster />
      </body>
    </html>
  );
}
