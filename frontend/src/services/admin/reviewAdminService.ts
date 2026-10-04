import type { AdminResult, AdminReview, ReviewStatus } from "@/types/admin";

import type { ReviewFilters } from "./admin-data-source";

import { adminDataSource } from "./admin-data-source.instance";

/** Review moderation. */

/** Every review, or those of one Product ID / Customer ID (matched exactly on the server). */
export function listReviews(filters: ReviewFilters = {}): Promise<AdminReview[]> {
  return adminDataSource.listReviews(filters);
}

export async function setReviewStatus(
  id: string,
  status: ReviewStatus,
): Promise<AdminResult<AdminReview>> {
  const reviews = await adminDataSource.listReviews();
  const review = reviews.find((entry) => entry.id === id);
  if (!review) return { ok: false, reason: "That review no longer exists." };
  return { ok: true, data: await adminDataSource.setReviewStatus(id, status) };
}

export async function deleteReview(id: string): Promise<AdminResult<string>> {
  const reviews = await adminDataSource.listReviews();
  const review = reviews.find((entry) => entry.id === id);
  if (!review) return { ok: false, reason: "That review no longer exists." };
  await adminDataSource.deleteReview(id);
  return { ok: true, data: review.title };
}

/** Reviews awaiting moderation. Drives the sidebar badge. */
