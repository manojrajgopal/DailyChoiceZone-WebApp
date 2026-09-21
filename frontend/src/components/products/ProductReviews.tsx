import { BadgeCheck } from "lucide-react";

import type { Review, ReviewSummary } from "@/types";

import { Rating } from "@/components/ui/Rating";
import { formatDate } from "@/lib/utils/format";

/**
 * Ratings breakdown and review list.
 *
 * The distribution bars and the list are both computed from the same review
 * set, so the summary can never disagree with what is shown underneath it.
 */
export function ProductReviews({
  reviews,
  summary,
}: {
  reviews: Review[];
  summary: ReviewSummary;
}) {
  if (summary.total === 0) {
    return (
      <p className="text-sm text-ink-500">
        No reviews yet. Be the first to write one once your order arrives.
      </p>
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[18rem_1fr] lg:gap-14">
      {/* -------------------------------------------------------- summary */}
      <div>
        <div className="flex items-end gap-3">
          <span className="font-display text-4xl leading-none text-ink tabular-nums">
            {summary.average.toFixed(1)}
          </span>
          <span className="pb-1 text-sm text-ink-400">out of 5</span>
        </div>

        <Rating value={summary.average} showValue={false} size="md" className="mt-2.5" />

        <p className="mt-2 text-xs text-ink-500 tabular-nums">
          Based on {summary.total} {summary.total === 1 ? "review" : "reviews"}
        </p>

        <ul className="mt-5 flex flex-col gap-1.5">
          {summary.distribution.map((row) => {
            const percent = summary.total > 0 ? (row.count / summary.total) * 100 : 0;
            return (
              <li key={row.stars} className="flex items-center gap-2.5 text-xs">
                <span className="w-8 shrink-0 text-ink-500 tabular-nums">{row.stars}★</span>
                <span
                  className="h-1.5 flex-1 overflow-hidden rounded-pill bg-ink-100"
                  role="img"
                  aria-label={`${row.count} of ${summary.total} reviews gave ${row.stars} stars`}
                >
                  <span
                    className="block h-full rounded-pill bg-copper-500"
                    style={{ width: `${percent}%` }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right text-ink-400 tabular-nums">
                  {row.count}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ---------------------------------------------------------- list */}
      <ul className="flex flex-col divide-y divide-ink-100">
        {reviews.map((review) => (
          <li key={review.id} className="py-5 first:pt-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Rating value={review.rating} showValue={false} />
              <p className="text-sm font-medium text-ink">{review.title}</p>
            </div>

            <p className="mt-2.5 text-sm leading-relaxed text-ink-700">{review.body}</p>

            <p className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-400">
              <span>{review.author}</span>
              <span aria-hidden="true">&middot;</span>
              <time dateTime={review.date}>{formatDate(review.date)}</time>
              {review.verified ? (
                <>
                  <span aria-hidden="true">&middot;</span>
                  <span className="inline-flex items-center gap-1 text-sage-600">
                    <BadgeCheck className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                    Verified purchase
                  </span>
                </>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
