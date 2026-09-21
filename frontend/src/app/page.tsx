import type { Metadata } from "next";

import { HomeSectionRenderer } from "@/components/home/HomeSectionRenderer";
import { getHomepageConfig, getSiteConfig } from "@/services/siteService";

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
  const { sections } = await getHomepageConfig();

  return (
    <div className="flex flex-col gap-16 py-10 sm:gap-20 sm:py-12">
      {sections.map((section) => (
        <HomeSectionRenderer key={section.id} section={section} />
      ))}
    </div>
  );
}
