import type { MetadataRoute } from "next";

import { getCategories, getCollections } from "@/services/categoryService";
import { getProducts } from "@/services/productService";
import { getSiteConfig } from "@/services/siteService";

/**
 * The sitemap, generated from the catalogue rather than hand-maintained.
 *
 * Adding a product to products.json puts it in the sitemap automatically —
 * which is the same principle as everywhere else in this app.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [config, categories, collections, products] = await Promise.all([
    getSiteConfig(),
    getCategories(),
    getCollections(),
    getProducts({ pageSize: 1000, page: 1 }),
  ]);

  const base = config.url;
  const now = new Date();

  const staticRoutes = [
    { path: "", priority: 1 },
    { path: "/shop", priority: 0.9 },
    { path: "/about", priority: 0.5 },
    { path: "/contact", priority: 0.5 },
    { path: "/faq", priority: 0.5 },
    { path: "/shipping", priority: 0.4 },
    { path: "/returns", priority: 0.4 },
    { path: "/privacy", priority: 0.3 },
    { path: "/terms", priority: 0.3 },
  ];

  return [
    ...staticRoutes.map((route) => ({
      url: `${base}${route.path}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: route.priority,
    })),
    ...categories.map((category) => ({
      url: `${base}/category/${category.slug}`,
      lastModified: now,
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
    ...collections.map((collection) => ({
      url: `${base}/collection/${collection.slug}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
    ...products.items.map((product) => ({
      url: `${base}/product/${product.slug}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
