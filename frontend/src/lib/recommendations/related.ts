import type { Product } from "@/types/product";

/**
 * A transparent, frontend-only recommendation heuristic.
 *
 * Kept deliberately explainable: products score points for sharing a
 * subcategory, category, tags, brand and price band with the seed product.
 * That is enough to make "Related products" genuinely relevant without
 * pretending to be a recommender system.
 *
 * When a real `/recommendations` endpoint exists, `productService` swaps to it
 * and this file can be deleted — nothing in the UI imports it directly.
 */

const WEIGHTS = {
  subcategory: 50,
  category: 20,
  tag: 8,
  brand: 10,
  priceBand: 12,
  inStock: 6,
  rating: 4,
} as const;

/** Same price band means within ±40% of the seed's price. */
function inSamePriceBand(seedPrice: number, price: number): boolean {
  if (seedPrice <= 0) return false;
  const ratio = price / seedPrice;
  return ratio >= 0.6 && ratio <= 1.4;
}

function similarity(seed: Product, candidate: Product): number {
  let score = 0;

  if (candidate.subcategory === seed.subcategory) score += WEIGHTS.subcategory;
  if (candidate.category === seed.category) score += WEIGHTS.category;
  if (candidate.brand === seed.brand) score += WEIGHTS.brand;
  if (inSamePriceBand(seed.price, candidate.price)) score += WEIGHTS.priceBand;
  if (candidate.stock > 0) score += WEIGHTS.inStock;

  const seedTags = new Set(seed.tags);
  const shared = candidate.tags.filter((tag) => seedTags.has(tag)).length;
  score += shared * WEIGHTS.tag;

  score += candidate.rating * WEIGHTS.rating;

  return score;
}

/**
 * Products similar to `seed`, best first.
 *
 * The seed itself is always excluded. Ties break on rating then id, so the
 * order is stable between renders rather than shuffling on every request.
 */
export function findRelated(seed: Product, catalogue: Product[], limit = 8): Product[] {
  return catalogue
    .filter((candidate) => candidate.id !== seed.id)
    .map((candidate) => ({ candidate, score: similarity(seed, candidate) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.rating - a.candidate.rating ||
        a.candidate.id.localeCompare(b.candidate.id),
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/**
 * Recommendations for a shopper, derived from what they have recently viewed.
 *
 * Each recently viewed product contributes candidates, weighted so the most
 * recent view counts for most. With no history at all, the caller falls back
 * to featured products — handled in `productService`, not here.
 */
export function findRecommended(
  recentlyViewed: Product[],
  catalogue: Product[],
  limit = 8,
): Product[] {
  if (recentlyViewed.length === 0) return [];

  const seen = new Set(recentlyViewed.map((product) => product.id));
  const scores = new Map<string, number>();

  recentlyViewed.slice(0, 5).forEach((seed, index) => {
    // 1, 0.8, 0.6 … so the newest view dominates.
    const recencyWeight = 1 - index * 0.2;
    catalogue.forEach((candidate) => {
      if (seen.has(candidate.id)) return;
      const score = similarity(seed, candidate) * recencyWeight;
      scores.set(candidate.id, (scores.get(candidate.id) ?? 0) + score);
    });
  });

  const byId = new Map(catalogue.map((product) => [product.id, product]));

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id]) => byId.get(id))
    .filter((product): product is Product => product !== undefined);
}
