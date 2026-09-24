import type { Review, ReviewSummary } from "@/types";

import { dataSource } from "./data-source.instance";

export function getReviews(productId: string): Promise<Review[]> {
  return dataSource.listReviews(productId);
}

/**
 * The ratings breakdown on a product page.
 *
 * Aggregated by the server, over the same approved reviews the list below it
 * shows, so the bar chart and the list cannot disagree. It used to be counted
 * here from the fetched array, which was one more implementation of the same
 * sum and would have drifted the first time either side changed what
 * "approved" meant.
 */
export function getReviewSummary(productId: string): Promise<ReviewSummary> {
  return dataSource.getReviewSummary(productId);
}
