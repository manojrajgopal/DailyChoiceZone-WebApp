import type { Category } from "@/types";
import type { AdminResult } from "@/types/admin";

import { slugify } from "@/lib/utils/format";

import { adminDataSource } from "./admin-data-source.instance";

/** Category management. Categories are shared with the storefront verbatim. */

export function listCategories(): Promise<Category[]> {
  return adminDataSource.listCategories();
}

/** How many products sit in each category. Shown in the table. */
export async function countProductsByCategory(): Promise<Record<string, number>> {
  const products = await adminDataSource.listProducts();
  return products.reduce<Record<string, number>>((counts, product) => {
    counts[product.category] = (counts[product.category] ?? 0) + 1;
    return counts;
  }, {});
}

export async function saveCategory(category: Category): Promise<AdminResult<Category>> {
  if (category.name.trim().length < 2) {
    return { ok: false, reason: "Enter a category name." };
  }

  const slug = category.slug.trim() || slugify(category.name);
  const existing = await adminDataSource.listCategories();
  const clash = existing.find((c) => c.slug === slug && c.id !== category.id);
  if (clash) return { ok: false, reason: `The slug "${slug}" is already used by ${clash.name}.` };

  return { ok: true, data: await adminDataSource.saveCategory({ ...category, slug }) };
}

/**
 * Deleting a category is refused while products still reference it.
 *
 * Orphaned products would vanish from the storefront's category pages with no
 * obvious cause, which is far worse than an error message here.
 */
export async function deleteCategory(id: string): Promise<AdminResult<string>> {
  const categories = await adminDataSource.listCategories();
  const category = categories.find((c) => c.id === id);
  if (!category) return { ok: false, reason: "That category no longer exists." };

  const counts = await countProductsByCategory();
  const inUse = counts[category.slug] ?? 0;
  if (inUse > 0) {
    return {
      ok: false,
      reason: `${category.name} still has ${inUse} product${inUse === 1 ? "" : "s"}. Move them first.`,
    };
  }

  await adminDataSource.deleteCategory(id);
  return { ok: true, data: category.name };
}
