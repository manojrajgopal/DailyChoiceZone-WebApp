"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Check, Search, Trash2, X } from "lucide-react";

import type { AdminReview, ReviewStatus } from "@/types/admin";

import {
  AdminButton,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { DomainStatus, StatusBadge } from "@/components/admin/ui/StatusBadge";
import { Rating } from "@/components/ui/Rating";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate } from "@/lib/utils/format";
import {
  deleteReview,
  listReviews,
  setReviewStatus,
} from "@/services/admin/reviewAdminService";
import { toast } from "@/store/toastStore";

/**
 * Review moderation.
 *
 * Pending reviews are shown first by default, because this page exists to clear
 * that queue — sorting by date would bury the only rows that need action.
 */
export function AdminReviewsView() {
  const reviews = useAdminResource(() => listReviews(), []);

  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<ReviewStatus | "all">("pending");
  const [rating, setRating] = useState<number | "all">("all");
  const [reading, setReading] = useState<AdminReview | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminReview | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = reviews.data ?? [];

  const counts = useMemo(
    () => ({
      pending: rows.filter((review) => review.status === "pending").length,
      approved: rows.filter((review) => review.status === "approved").length,
      rejected: rows.filter((review) => review.status === "rejected").length,
    }),
    [rows],
  );

  const filtered = useMemo(() => {
    const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter((review) => {
      if (status !== "all" && review.status !== status) return false;
      if (rating !== "all" && review.rating !== rating) return false;
      if (terms.length > 0) {
        const haystack = [review.productName, review.customerName, review.title, review.body]
          .join(" ")
          .toLowerCase();
        if (!terms.every((token) => haystack.includes(token))) return false;
      }
      return true;
    });
  }, [rows, term, status, rating]);

  const moderate = async (review: AdminReview, next: ReviewStatus) => {
    setBusy(true);
    const result = await setReviewStatus(review.id, next);
    setBusy(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(next === "approved" ? "Review approved" : "Review rejected");
    setReading(null);
    await reviews.reload();
  };

  const onDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    const result = await deleteReview(pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success("Review deleted");
    await reviews.reload();
  };

  const columns: Column<AdminReview>[] = [
    {
      id: "product",
      header: "Product",
      sortValue: (review) => review.productName,
      cell: (review) => (
        <span className="flex items-center gap-2.5">
          <span className="h-9 w-7 shrink-0 overflow-hidden rounded-[2px] bg-admin-raised">
            {review.productImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={review.productImage} alt="" className="h-full w-full object-cover" />
            ) : null}
          </span>
          <Link
            href={`/admin/products/edit?id=${review.productId}`}
            className="block max-w-[11rem] truncate text-xs text-admin-ink hover:text-copper-700"
          >
            {review.productName}
          </Link>
        </span>
      ),
    },
    {
      id: "customer",
      header: "Customer",
      hideBelow: "md",
      sortValue: (review) => review.customerName,
      cell: (review) => (
        <span className="min-w-0">
          <span className="block truncate text-xs text-admin-ink">{review.customerName}</span>
          {review.verifiedPurchase ? (
            <span className="block text-[0.5625rem] text-[#0a6b0a]">Verified purchase</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "rating",
      header: "Rating",
      sortValue: (review) => review.rating,
      cell: (review) => <Rating value={review.rating} showValue={false} />,
    },
    {
      id: "review",
      header: "Review",
      hideBelow: "lg",
      cell: (review) => (
        <button
          type="button"
          onClick={() => setReading(review)}
          className="block max-w-[18rem] text-left"
        >
          <span className="block truncate text-xs font-medium text-admin-ink hover:text-copper-700">
            {review.title}
          </span>
          <span className="block truncate text-[0.625rem] text-admin-faint">{review.body}</span>
        </button>
      ),
    },
    {
      id: "date",
      header: "Submitted",
      hideBelow: "xl",
      sortValue: (review) => review.submittedAt,
      cell: (review) => (
        <span className="whitespace-nowrap text-[0.6875rem] text-admin-muted">
          {formatDate(review.submittedAt)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (review) => review.status,
      cell: (review) => <DomainStatus domain="review" status={review.status} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (review) => (
        <span className="flex items-center justify-end gap-0.5">
          {review.status !== "approved" ? (
            <button
              type="button"
              onClick={() => void moderate(review, "approved")}
              disabled={busy}
              aria-label={`Approve review by ${review.customerName}`}
              title="Approve"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#e8f6e8] hover:text-[#0a6b0a] disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          ) : null}

          {review.status !== "rejected" ? (
            <button
              type="button"
              onClick={() => void moderate(review, "rejected")}
              disabled={busy}
              aria-label={`Reject review by ${review.customerName}`}
              title="Reject"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#fdf3dd] hover:text-[#8a5d00] disabled:opacity-40"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => setPendingDelete(review)}
            aria-label={`Delete review by ${review.customerName}`}
            title="Delete"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424]"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </span>
      ),
    },
  ];

  const selectClass =
    "h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink hover:border-admin-border-strong focus:border-copper-500";

  return (
    <div>
      <AdminPageHeader
        title="Reviews"
        description="Moderate what appears on product pages."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Reviews" }]}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-[3px] border border-admin-border bg-admin-surface p-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <label htmlFor="review-search" className="sr-only">
            Search reviews by product, customer or text
          </label>
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <input
            id="review-search"
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Product, customer or text…"
            className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-raised pl-8 pr-2 text-xs text-admin-ink placeholder:text-admin-faint focus:border-copper-500 focus:bg-admin-surface"
          />
        </div>

        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as ReviewStatus | "all")}
          aria-label="Filter by moderation status"
          className={selectClass}
        >
          <option value="pending">Pending ({counts.pending})</option>
          <option value="approved">Approved ({counts.approved})</option>
          <option value="rejected">Rejected ({counts.rejected})</option>
          <option value="all">All reviews</option>
        </select>

        <select
          value={String(rating)}
          onChange={(event) =>
            setRating(event.target.value === "all" ? "all" : Number(event.target.value))
          }
          aria-label="Filter by rating"
          className={selectClass}
        >
          <option value="all">Any rating</option>
          {[5, 4, 3, 2, 1].map((value) => (
            <option key={value} value={value}>
              {value} star{value === 1 ? "" : "s"}
            </option>
          ))}
        </select>

        <p className="ml-auto text-[0.6875rem] text-admin-muted tabular-nums">
          {reviews.isLoading ? "Loading…" : `${filtered.length} shown`}
        </p>
      </div>

      {counts.pending > 0 && status !== "pending" ? (
        <p className="mb-3 rounded-[3px] bg-[#fdf3dd] px-3 py-2 text-xs text-[#8a5d00]">
          {counts.pending} review{counts.pending === 1 ? "" : "s"} still awaiting moderation.{" "}
          <button
            type="button"
            onClick={() => setStatus("pending")}
            className="font-medium underline underline-offset-2"
          >
            Show them
          </button>
        </p>
      ) : null}

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(review) => review.id}
        onRowClick={(review) => setReading(review)}
        isLoading={reviews.isLoading}
        pageSize={15}
        initialSort={{ columnId: "date", direction: "desc" }}
        emptyTitle="Nothing to moderate"
        emptyDescription="No reviews match the current filters."
      />

      {/* ---------------------------------------------------- read modal */}
      <Modal
        open={reading !== null}
        onOpenChange={(open) => !open && setReading(null)}
        title={reading?.title ?? "Review"}
        className="max-w-lg"
      >
        {reading ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <Rating value={reading.rating} />
              <DomainStatus domain="review" status={reading.status} />
              {reading.verifiedPurchase ? (
                <StatusBadge tone="good">Verified purchase</StatusBadge>
              ) : null}
            </div>

            <p className="text-sm leading-relaxed text-admin-ink">{reading.body}</p>

            <dl className="grid grid-cols-2 gap-3 rounded-[3px] bg-admin-raised p-3 text-xs">
              <div>
                <dt className="text-[0.625rem] uppercase tracking-[0.1em] text-admin-muted">
                  Customer
                </dt>
                <dd className="mt-0.5 text-admin-ink">{reading.customerName}</dd>
              </div>
              <div>
                <dt className="text-[0.625rem] uppercase tracking-[0.1em] text-admin-muted">
                  Submitted
                </dt>
                <dd className="mt-0.5 text-admin-ink">{formatDate(reading.submittedAt)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[0.625rem] uppercase tracking-[0.1em] text-admin-muted">
                  Product
                </dt>
                <dd className="mt-0.5">
                  <Link
                    href={`/admin/products/edit?id=${reading.productId}`}
                    className="text-admin-ink hover:text-copper-700"
                  >
                    {reading.productName}
                  </Link>
                </dd>
              </div>
            </dl>

            <div className="flex flex-wrap justify-end gap-2">
              <AdminButton variant="secondary" onClick={() => setReading(null)}>
                Close
              </AdminButton>
              {reading.status !== "rejected" ? (
                <AdminButton
                  variant="secondary"
                  loading={busy}
                  onClick={() => void moderate(reading, "rejected")}
                >
                  Reject
                </AdminButton>
              ) : null}
              {reading.status !== "approved" ? (
                <AdminButton
                  variant="primary"
                  loading={busy}
                  onClick={() => void moderate(reading, "approved")}
                >
                  Approve
                </AdminButton>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete review?"
        loading={busy}
        confirmLabel="Delete review"
        message={
          <>
            Permanently delete this review of{" "}
            <strong className="text-admin-ink">{pendingDelete?.productName}</strong>? Rejecting it
            hides it from the storefront while keeping the record — prefer that unless it needs to
            be gone entirely.
          </>
        }
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
