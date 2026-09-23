import type { Metadata } from "next";

import { HomeSectionRenderer } from "@/components/home/HomeSectionRenderer";
import { HomeSections } from "@/components/home/HomeSections";
import {
  getHomepageConfig,
  getHomeSectionLayout,
  getSiteConfig,
} from "@/services/siteService";

export async function generateMetadata(): Promise<Metadata> {
  const config = await getSiteConfig();
  return {
    // The root page overrides the title template with the full brand line.
    title: `${config.name} — ${config.tagline}`,
    description: config.description,
    alternates: { canonical: "/" },
  };
}

/**
 * The storefront home page.
 *
 * Deliberately *not* a landing page. There is no hero, no welcome message and
 * no marketing preamble: the first thing below the header is a rail of real,
 * buyable products, the way a shopper arriving at a store expects.
 *
 * The page itself holds no layout decisions. It reads `homepage.json` and
 * renders whatever sections it describes, in order — so rails can be retitled,
 * reordered, added or removed without touching this file.
 */
export default async function HomePage() {
  const [{ sections }, layout] = await Promise.all([
    getHomepageConfig(),
    getHomeSectionLayout(),
  ]);

  return (
    <HomeSections
      initialLayout={layout}
      sections={sections.map((section) => ({
        id: section.id,
        node: <HomeSectionRenderer section={section} />,
      }))}
    />
  );
}
