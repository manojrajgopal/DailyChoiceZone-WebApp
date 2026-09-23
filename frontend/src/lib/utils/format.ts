/**
 * Display formatting.
 *
 * Everything routes through a single set of formatters so prices and dates
 * look identical on the server and in the browser — mismatched locale output
 * is a classic source of hydration warnings.
 */

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

const INR_COMPACT = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
});

/** `1299` becomes `₹1,299`. */
export function formatPrice(value: number): string {
  return INR.format(Math.round(value));
}

/** `1299` becomes `1,299` — for when the symbol is rendered separately. */
export function formatNumber(value: number): string {
  return INR_COMPACT.format(Math.round(value));
}

/** `2026-04-11` becomes `11 Apr 2026`. */
export function formatDate(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** `438` becomes `438`; `1280` becomes `1.3k`. Keeps review counts compact. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** Percent off, floored so we never overstate a discount. */
export function discountPercent(price: number, originalPrice: number): number {
  if (originalPrice <= 0 || originalPrice <= price) return 0;
  return Math.floor(((originalPrice - price) / originalPrice) * 100);
}

/** A stable, URL-safe slug. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Sentence-case a slug for display, e.g. `belts-wallets` to `Belts wallets`. */
export function humanize(slug: string): string {
  const spaced = slug.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A delivery estimate in plain language, counting only business days.
 *
 * Purely presentational today. A real backend would return a promised date and
 * this would format that instead of computing it.
 */
export function deliveryEstimate(businessDays: number, from: Date = new Date()): string {
  const date = new Date(from);
  let added = 0;
  while (added < businessDays) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) added += 1;
  }
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

/**
 * Compact rupees for chart axes and KPI tiles: 85,400 becomes "₹85.4k",
 * 284,560 becomes "₹2.85L".
 *
 * Uses the Indian lakh/crore scale rather than millions, because that is how
 * the figures will be read aloud by the people using this dashboard.
 */
export function formatCompactINR(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10000000) return `₹${(value / 10000000).toFixed(2).replace(/\.00$/, "")}Cr`;
  if (abs >= 100000) return `₹${(value / 100000).toFixed(2).replace(/\.00$/, "")}L`;
  if (abs >= 1000) return `₹${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `₹${Math.round(value)}`;
}

/** Compact plain numbers on the same scale. */
export function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10000000) return `${(value / 10000000).toFixed(2).replace(/\.00$/, "")}Cr`;
  if (abs >= 100000) return `${(value / 100000).toFixed(2).replace(/\.00$/, "")}L`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}

/**
 * A chart axis label for one of our series labels.
 *
 * Handles the three shapes the analytics data uses: an hour ("08:00"), a day
 * ("2026-09-18") and a month ("2026-09").
 */
export function formatSeriesLabel(label: string): string {
  if (/^\d{2}:\d{2}$/.test(label)) return label;

  if (/^\d{4}-\d{2}$/.test(label)) {
    const date = new Date(`${label}-01T00:00:00Z`);
    return new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "UTC" }).format(date);
  }

  const date = new Date(`${label}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return label;
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}
