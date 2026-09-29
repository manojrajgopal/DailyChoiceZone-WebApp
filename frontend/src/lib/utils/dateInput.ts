/**
 * Dates chosen in a date picker, as whole days in the admin's own timezone.
 *
 * The server keeps times in UTC and sends them without a zone marker. A coupon
 * the admin sets to run "29 Sept – 30 Sept" means from the first moment of the
 * 29th to the last moment of the 30th **where the admin is** — in India, from
 * 18:30 UTC on the 28th to 18:29 UTC on the 30th. Treating the picked date as
 * UTC midnight instead is what made a coupon started "today" refuse to apply
 * until 05:30 the next morning.
 */

/** A server timestamp (UTC, possibly without a zone marker) as a Date. */
export function fromServerTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`;
  const date = new Date(zoned);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A server timestamp as the `yyyy-MM-dd` a date input shows, in local time. */
export function toDateInput(value: string | null | undefined): string {
  const date = fromServerTime(value);
  if (!date) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The first moment of a picked day, local time, as ISO (UTC). */
export function startOfDay(value: string): string | null {
  return value ? new Date(`${value}T00:00:00`).toISOString() : null;
}

/** The last moment of a picked day, local time, as ISO (UTC). */
export function endOfDay(value: string): string | null {
  return value ? new Date(`${value}T23:59:59.999`).toISOString() : null;
}

/** A server timestamp as a readable local date, e.g. "30 Sept 2026". */
export function formatLocalDate(value: string | null | undefined): string {
  const date = fromServerTime(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}
