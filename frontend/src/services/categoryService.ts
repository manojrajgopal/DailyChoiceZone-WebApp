import type { Category, Collection, Product } from "@/types";

import { dataSource } from "./data-source.instance";

export function getCategories(): Promise<Category[]> {
  return dataSource.listCategories();
}

/** Categories flagged for the homepage grid, in curated order. */
export async function getFeaturedCategories(limit?: number): Promise<Category[]> {
  const categories = await dataSource.listCategories();
  const featured = categories.filter((category) => category.featured);
  return typeof limit === "number" ? featured.slice(0, limit) : featured;
}

export function getCategoryBySlug(slug: string): Promise<Category | null> {
  return dataSource.getCategoryBySlug(slug);
}

/** Flatten a category's groups into a single subcategory list. */
export async function getSubcategories(
  categorySlug: string,
): Promise<{ slug: string; name: string }[]> {
  const category = await dataSource.getCategoryBySlug(categorySlug);
  if (!category) return [];
  return category.groups.flatMap((group) => group.items);
}

/* ---------------------------------------------------------------- collections */

export function getCollections(): Promise<Collection[]> {
  return dataSource.listCollections();
}

export async function getFeaturedCollections(limit?: number): Promise<Collection[]> {
  const collections = await dataSource.listCollections();
  const featured = collections.filter((collection) => collection.featured);
  return typeof limit === "number" ? featured.slice(0, limit) : featured;
}

export function getCollectionBySlug(slug: string): Promise<Collection | null> {
  return dataSource.getCollectionBySlug(slug);
}

/**
 * A collection together with its resolved products.
 *
 * Returns `null` for an unknown slug so the page can render a 404 rather than
 * an empty collection, which would look like a bug to a shopper.
 */
export async function getCollectionWithProducts(
  slug: string,
): Promise<{ collection: Collection; products: Product[] } | null> {
  const collection = await dataSource.getCollectionBySlug(slug);
  if (!collection) return null;
  const products = await dataSource.getProductsByIds(collection.productIds);
  return { collection, products };
}
