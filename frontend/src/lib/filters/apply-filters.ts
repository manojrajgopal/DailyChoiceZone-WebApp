import type {
  FacetOption,
  Paginated,
  Product,
  ProductFacets,
  ProductFilters,
  ProductQuery,
  SortOption,
} from "@/types/product";

import { humanize } from "@/lib/utils/format";

export const DEFAULT_PAGE_SIZE = 24;

/* ------------------------------------------------------------------ matching */

/** Case-insensitive membership test that tolerates an empty filter list. */
function matchesAny(value: string, selected: string[] | undefined): boolean {
  if (!selected || selected.length === 0) return true;
  return selected.some((candidate) => candidate.toLowerCase() === value.toLowerCase());
}

/**
 * Free-text match across the fields a shopper would expect to search.
 *
 * Every term must appear somewhere in the product's searchable text, so
 * "linen shirt" narrows rather than widens. That is the behaviour people
 * expect from a search box, even though it is the opposite of an OR search.
 */
function matchesQuery(product: Product, query: string | undefined): boolean {
  if (!query) return true;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = [
    product.name,
    product.brand,
    product.category,
    product.subcategory,
    product.material,
    product.description,
    ...product.tags,
    ...product.colors.map((c) => c.name),
  ]
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

/** Does a single product satisfy every active filter? */
export function matchesFilters(product: Product, filters: ProductFilters): boolean {
  if (!matchesAny(product.category, filters.category)) return false;
  if (!matchesAny(product.subcategory, filters.subcategory)) return false;
  if (!matchesAny(product.brand, filters.brand)) return false;

  if (filters.size && filters.size.length > 0) {
    const has = product.sizes.some((size) =>
      filters.size?.some((selected) => selected.toLowerCase() === size.toLowerCase()),
    );
    if (!has) return false;
  }

  if (filters.color && filters.color.length > 0) {
    const has = product.colors.some((color) =>
      filters.color?.some((selected) => selected.toLowerCase() === color.name.toLowerCase()),
    );
    if (!has) return false;
  }

  if (typeof filters.minPrice === "number" && product.price < filters.minPrice) return false;
  if (typeof filters.maxPrice === "number" && product.price > filters.maxPrice) return false;
  if (typeof filters.minRating === "number" && product.rating < filters.minRating) return false;
  if (typeof filters.minDiscount === "number" && product.discount < filters.minDiscount) {
    return false;
  }
  if (filters.inStockOnly && product.stock <= 0) return false;

  return matchesQuery(product, filters.query);
}

/* ------------------------------------------------------------------- sorting */

/**
 * "Recommended" is the default order, and it needs to be *opinionated* rather
 * than arbitrary: in-stock first, then a blend of merchandising flags, rating
 * and review volume. Without this, the default view is just insertion order,
 * which looks unconsidered.
 */
function recommendedScore(product: Product): number {
  let score = 0;
  if (product.stock > 0) score += 1000;
  if (product.isFeatured) score += 120;
  if (product.isBestSeller) score += 90;
  if (product.isTrending) score += 70;
  if (product.isNew) score += 50;
  score += product.rating * 20;
  score += Math.min(product.reviewCount, 500) / 25;
  score += Math.min(product.discount, 50) / 5;
  return score;
}

const COMPARATORS: Record<SortOption, (a: Product, b: Product) => number> = {
  recommended: (a, b) => recommendedScore(b) - recommendedScore(a),
  // No timestamps in the catalogue, so `isNew` is the best proxy available;
  // ties fall back to the recommended blend rather than insertion order.
  newest: (a, b) =>
    Number(b.isNew) - Number(a.isNew) || recommendedScore(b) - recommendedScore(a),
  "price-asc": (a, b) => a.price - b.price,
  "price-desc": (a, b) => b.price - a.price,
  rating: (a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount,
  popular: (a, b) => b.reviewCount - a.reviewCount || b.rating - a.rating,
  discount: (a, b) => b.discount - a.discount || recommendedScore(b) - recommendedScore(a),
};

export function sortProducts(products: Product[], sort: SortOption = "recommended"): Product[] {
  const comparator = COMPARATORS[sort] ?? COMPARATORS.recommended;
  // Copy first: callers pass the shared catalogue array and must not see it
  // reordered underneath them.
  return [...products].sort(comparator);
}

/* ---------------------------------------------------------------- pagination */

export function paginate<T>(items: T[], page = 1, pageSize = DEFAULT_PAGE_SIZE): Paginated<T> {
  const safeSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(items.length / safeSize));
  // Clamp rather than 404: a stale ?page=9 link should show the last page.
  const safePage = Math.min(Math.max(1, Math.trunc(page)), totalPages);
  const start = (safePage - 1) * safeSize;

  return {
    items: items.slice(start, start + safeSize),
    total: items.length,
    page: safePage,
    pageSize: safeSize,
    totalPages,
  };
}

/* -------------------------------------------------------------- full pipeline */

/** Filter, sort and paginate in one pass. The listing pages' workhorse. */
export function queryProducts(products: Product[], query: ProductQuery = {}): Paginated<Product> {
  const { sort, page, pageSize, ...filters } = query;
  const filtered = products.filter((product) => matchesFilters(product, filters));
  const sorted = sortProducts(filtered, sort);
  return paginate(sorted, page ?? 1, pageSize ?? DEFAULT_PAGE_SIZE);
}

/* --------------------------------------------------------------------- facets */

function toOptions(counts: Map<string, number>, label?: (value: string) => string): FacetOption[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: label ? label(value) : value, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function tally(values: string[], into: Map<string, number>): void {
  values.forEach((value) => into.set(value, (into.get(value) ?? 0) + 1));
}

/**
 * Build the filter panel's options from a product set.
 *
 * Facets are computed from the products that match everything *except* the
 * facet being displayed — that is the ideal. Here they are computed from one
 * supplied set, which keeps the implementation simple and honest: pass the
 * category's products and the panel shows that category's brands and sizes,
 * with real counts rather than a fixed hardcoded list.
 */
export function buildFacets(products: Product[]): ProductFacets {
  const categories = new Map<string, number>();
  const subcategories = new Map<string, number>();
  const brands = new Map<string, number>();
  const sizes = new Map<string, number>();
  const colors = new Map<string, number>();

  let min = Number.POSITIVE_INFINITY;
  let max = 0;

  products.forEach((product) => {
    tally([product.category], categories);
    tally([product.subcategory], subcategories);
    tally([product.brand], brands);
    tally(product.sizes, sizes);
    tally(
      product.colors.map((c) => c.name),
      colors,
    );
    if (product.price < min) min = product.price;
    if (product.price > max) max = product.price;
  });

  // Keep clothing sizes in wardrobe order rather than by popularity; numeric
  // and lettered sizes each need their own rule.
  const SIZE_ORDER = ["XS", "S", "M", "L", "XL", "XXL"];
  const sizeOptions = toOptions(sizes).sort((a, b) => {
    const ai = SIZE_ORDER.indexOf(a.value);
    const bi = SIZE_ORDER.indexOf(b.value);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    const an = Number.parseFloat(a.value.replace(/[^\d.]/g, ""));
    const bn = Number.parseFloat(b.value.replace(/[^\d.]/g, ""));
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
    return a.value.localeCompare(b.value);
  });

  return {
    categories: toOptions(categories, humanize),
    subcategories: toOptions(subcategories, humanize),
    brands: toOptions(brands),
    sizes: sizeOptions,
    colors: toOptions(colors),
    priceRange: {
      min: Number.isFinite(min) ? Math.floor(min) : 0,
      max: max > 0 ? Math.ceil(max) : 0,
    },
  };
}

/** How many filters are active — drives the "Filters (3)" badge. */
export function countActiveFilters(filters: ProductFilters): number {
  let count = 0;
  count += filters.category?.length ?? 0;
  count += filters.subcategory?.length ?? 0;
  count += filters.brand?.length ?? 0;
  count += filters.size?.length ?? 0;
  count += filters.color?.length ?? 0;
  if (typeof filters.minPrice === "number" || typeof filters.maxPrice === "number") count += 1;
  if (typeof filters.minRating === "number") count += 1;
  if (typeof filters.minDiscount === "number") count += 1;
  if (filters.inStockOnly) count += 1;
  return count;
}
