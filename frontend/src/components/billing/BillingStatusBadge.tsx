import type {
  BillingPaymentStatus,
  CreditNoteStatus,
  InvoiceStatus,
  RefundStatus,
} from "@/types";

import { cn } from "@/lib/utils/cn";

/**
 * Status badges for every billing record.
 *
 * One component for all four vocabularies, because they are read side by side —
 * an invoice row shows its own status next to its payment's — and two badge
 * implementations would drift in padding, weight and colour until the table
 * looked assembled from parts.
 *
 * Colour never carries the meaning on its own: each badge prints its label, so
 * the state is legible in greyscale, to a colourblind reader, and in the
 * printed invoice.
 */

type Tone = "neutral" | "info" | "good" | "warning" | "critical";

const TONES: Record<Tone, string> = {
  neutral: "border-admin-border bg-admin-raised text-admin-muted",
  info: "border-chart-1/30 bg-chart-1/10 text-chart-1",
  good: "border-status-good/30 bg-status-good/10 text-status-good",
  warning: "border-status-warning/40 bg-status-warning/10 text-status-serious",
  critical: "border-status-critical/30 bg-status-critical/10 text-status-critical",
};

const INVOICE: Record<InvoiceStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  issued: { label: "Issued", tone: "info" },
  paid: { label: "Paid", tone: "good" },
  overdue: { label: "Overdue", tone: "critical" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const PAYMENT: Record<BillingPaymentStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warning" },
  authorized: { label: "Authorised", tone: "info" },
  paid: { label: "Paid", tone: "good" },
  failed: { label: "Failed", tone: "critical" },
  refunded: { label: "Refunded", tone: "neutral" },
  "partially-refunded": { label: "Part refunded", tone: "warning" },
};

const REFUND: Record<RefundStatus, { label: string; tone: Tone }> = {
  requested: { label: "Requested", tone: "warning" },
  processing: { label: "Processing", tone: "info" },
  completed: { label: "Completed", tone: "good" },
  rejected: { label: "Rejected", tone: "critical" },
};

const CREDIT_NOTE: Record<CreditNoteStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  issued: { label: "Issued", tone: "good" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

type BadgeProps =
  | { domain: "invoice"; status: InvoiceStatus }
  | { domain: "payment"; status: BillingPaymentStatus }
  | { domain: "refund"; status: RefundStatus }
  | { domain: "credit-note"; status: CreditNoteStatus };

export function BillingStatusBadge(props: BadgeProps & { className?: string }) {
  const entry =
    props.domain === "invoice"
      ? INVOICE[props.status]
      : props.domain === "payment"
        ? PAYMENT[props.status]
        : props.domain === "refund"
          ? REFUND[props.status]
          : CREDIT_NOTE[props.status];

  // An unrecognised status is shown rather than swallowed — a blank cell hides
  // a data problem, a raw value reports it.
  const label = entry?.label ?? props.status;
  const tone = entry?.tone ?? "neutral";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-[3px] border px-1.5 py-0.5 text-[0.625rem] font-medium tracking-[0.06em] uppercase",
        TONES[tone],
        props.className,
      )}
    >
      {label}
    </span>
  );
}
