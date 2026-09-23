import type { AdminResult, AdminReview, ReviewStatus } from "@/types/admin";

import { adminDataSource } from "./admin-data-source.instance";

/** Review moderation. */

export function listReviews(): Promise<AdminReview[]> {
  return adminDataSource.listReviews();
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
export async function countPendingReviews(): Promise<number> {
  const reviews = await adminDataSource.listReviews();
  return reviews.filter((review) => review.status === "pending").length;
}
