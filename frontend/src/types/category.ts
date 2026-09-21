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
