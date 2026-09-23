import type { MetadataRoute } from "next";

import { getSiteConfig } from "@/services/siteService";

/**
 * robots.txt.
 *
 * The admin portal, cart, checkout and account are all disallowed: they are
 * either private or personal, never useful in search results, and crawling
 * them wastes budget that should go to products.
 */
/**
 * Written once at build time.
 *
 * `output: "export"` has no server to generate this per request, so Next
 * requires the route to declare itself static explicitly.
 */
export const dynamic = "force-static";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const config = await getSiteConfig();

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/cart", "/checkout", "/account", "/order-success", "/search"],
      },
    ],
    sitemap: `${config.url}/sitemap.xml`,
  };
}
