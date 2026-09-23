import { cn } from "@/lib/utils/cn";

/**
 * Status pills.
 *
 * Every status in the portal resolves to one of five tones, and each pill
 * carries its label — colour is never the only signal. The tones map to the
 * reserved status palette rather than the chart series colours, because a
 * status means something fixed and must not be confused with "series 4".
 */

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral" | "info";

const TONES: Record<Tone, string> = {
  good: "bg-[#e8f6e8] text-[#0a6b0a] ring-[#0ca30c]/25",
  warning: "bg-[#fdf3dd] text-[#8a5d00] ring-[#fab219]/35",
  serious: "bg-[#fdeee7] text-[#9c4a24] ring-[#ec835a]/30",
  critical: "bg-[#fbeaea] text-[#a32424] ring-[#d03b3b]/25",
  neutral: "bg-admin-raised text-admin-muted ring-admin-border-strong",
  info: "bg-[#e9f1fc] text-[#1d5aa3] ring-[#2a78d6]/25",
};

export function StatusBadge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-[3px] px-2 py-0.5",
        "text-[0.6875rem] font-medium ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ----------------------------------------------- domain status → tone maps */

const ORDER_TONES: Record<string, Tone> = {
  pending: "warning",
  confirmed: "info",
  processing: "info",
  shipped: "info",
  delivered: "good",
  cancelled: "critical",
  returned: "serious",
};

const PAYMENT_TONES: Record<string, Tone> = {
  paid: "good",
  pending: "warning",
  "cod-pending": "warning",
  failed: "critical",
  refunded: "serious",
};

const PRODUCT_TONES: Record<string, Tone> = {
  active: "good",
  draft: "neutral",
  "out-of-stock": "critical",
  archived: "neutral",
};

const STOCK_TONES: Record<string, Tone> = {
  "in-stock": "good",
  "low-stock": "warning",
  "out-of-stock": "critical",
};

const REVIEW_TONES: Record<string, Tone> = {
  approved: "good",
  pending: "warning",
  rejected: "critical",
};

const COUPON_TONES: Record<string, Tone> = {
  active: "good",
  scheduled: "info",
  expired: "neutral",
  disabled: "neutral",
};

const GENERIC_TONES: Record<string, Tone> = {
  active: "good",
  disabled: "neutral",
  blocked: "critical",
};

/** Turn a kebab-case status into something readable. */
export function humanStatus(status: string): string {
  const spaced = status.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const MAPS = {
  order: ORDER_TONES,
  payment: PAYMENT_TONES,
  product: PRODUCT_TONES,
  stock: STOCK_TONES,
  review: REVIEW_TONES,
  coupon: COUPON_TONES,
  generic: GENERIC_TONES,
} as const;

/** A badge that knows the tone for a given domain's status vocabulary. */
export function DomainStatus({
  domain,
  status,
  className,
}: {
  domain: keyof typeof MAPS;
  status: string;
  className?: string;
}) {
  return (
    <StatusBadge tone={MAPS[domain][status] ?? "neutral"} className={className}>
      {humanStatus(status)}
    </StatusBadge>
  );
}
