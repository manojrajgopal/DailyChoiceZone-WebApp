"use client";

import { useEffect, useState } from "react";

import type { Review, ReviewSummary } from "@/types";
import { getReviewSummary, getReviews } from "@/services/reviewService";

/**
 * Keep a prerendered review list in step with moderation.
 *
 * Product pages are static HTML, so the reviews baked into one are the reviews
 * that were approved at build time. A moderator who approves or rejects
 * something afterwards has to see it published or taken down — otherwise the
 * moderation queue is a form that changes nothing.
 *
 * The build-time set renders on the server and on the first client pass, so
 * there is no hydration mismatch; both list and summary are then replaced
 * together, which is what stops the distribution bars disagreeing with the
 * reviews printed underneath them.
 */
export function useLiveReviews(
  productId: string,
  initialReviews: Review[],
  initialSummary: ReviewSummary,
): { reviews: Review[]; summary: ReviewSummary } {
  const [state, setState] = useState({
    reviews: initialReviews,
    summary: initialSummary,
  });

  useEffect(() => {
    let active = true;

    void Promise.all([getReviews(productId), getReviewSummary(productId)]).then(
      ([reviews, summary]) => {
        if (active) setState({ reviews, summary });
      },
    );

    return () => {
      active = false;
    };
  }, [productId]);

  return state;
}
