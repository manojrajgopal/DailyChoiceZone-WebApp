import type { Review, ReviewSummary } from "@/types";

import { dataSource } from "./data-source.instance";

export function getReviews(productId: string): Promise<Review[]> {
  return dataSource.listReviews(productId);
}

/**
 * Aggregate stats for the ratings breakdown on a product page.
 *
 * Computed from the reviews actually shown, so the bar chart and the list can
 * never disagree — which they would if this read the product's own `rating`.
 */
export async function getReviewSummary(productId: string): Promise<ReviewSummary> {
  const reviews = await dataSource.listReviews(productId);

  if (reviews.length === 0) {
    return {
      average: 0,
      total: 0,
      distribution: [5, 4, 3, 2, 1].map((stars) => ({ stars, count: 0 })),
    };
  }

  const total = reviews.length;
  const sum = reviews.reduce((acc, review) => acc + review.rating, 0);

  return {
    average: Math.round((sum / total) * 10) / 10,
    total,
    distribution: [5, 4, 3, 2, 1].map((stars) => ({
      stars,
      count: reviews.filter((review) => review.rating === stars).length,
    })),
  };
}
