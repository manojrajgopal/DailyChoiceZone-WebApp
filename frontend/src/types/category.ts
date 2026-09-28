export interface Subcategory {
  slug: string;
  name: string;
}

export interface CategoryGroup {
  /** Column heading inside the mega menu, e.g. "Clothing". */
  name: string;
  items: Subcategory[];
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  description: string;
  image: string;
  /** Drives both the mega menu and the category landing page. */
  groups: CategoryGroup[];
  /** Ordering hint for "Shop by category". Lower sorts first. */
  order: number;
  featured: boolean;
  /**
   * How many products are in it.
   *
   * Counted in SQL and present only when asked for (`?withCounts=true`), so
   * the storefront's menu is not paying for a count it does not show.
   */
  productCount?: number;
}

export interface Collection {
  id: string;
  slug: string;
  name: string;
  description: string;
  image: string;
  /** Explicit, curated membership — not computed from flags. */
  productIds: string[];
  featured: boolean;
}
