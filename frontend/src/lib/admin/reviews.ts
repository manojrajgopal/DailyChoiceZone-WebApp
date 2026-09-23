import adminReviewsJson from "@/data/admin/reviews.json";

import type { AdminReview } from "@/types/admin";

import { OVERLAY_KEYS, resolve } from "./mock-store";

/**
 * The reviews a moderator has approved for publication.
 *
 * Reviews are one set of records with two projections: `reviews.json` holds
 * what a product page renders, `admin/reviews.json` holds the moderation state,
 * and they share ids. The storefront asks this module which of them are cleared
 * to show.
 *
 * Without it the moderation queue would be theatre — a pending review would
 * already be on the product page, and rejecting one would not take it down.
 */
export function approvedReviewIds(): Set<string> {
  const reviews = resolve(adminReviewsJson as AdminReview[], OVERLAY_KEYS.reviews);

  return new Set(
    reviews.filter((review) => review.status === "approved").map((review) => review.id),
  );
}
