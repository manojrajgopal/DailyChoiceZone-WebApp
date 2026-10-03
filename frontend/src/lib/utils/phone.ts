/**
 * Indian mobile numbers, as people type them and as the API stores them.
 *
 * Typed: "98765 43210", "+91 98765-43210", "098765 43210". Stored by the API
 * once confirmed: "+919876543210". Both are the same ten digits.
 */

/** The ten digits of an Indian mobile number, or null when it isn't one. */
export function normaliseMobile(raw: string | null | undefined): string | null {
  let digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/** Whether two ways of writing a number are the same number. */
export function sameMobile(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normaliseMobile(a);
  return left !== null && left === normaliseMobile(b);
}

/** For display: "98765 43210" for a mobile number, the value unchanged otherwise. */
export function formatMobile(raw: string | null | undefined): string {
  const digits = normaliseMobile(raw);
  return digits ? `${digits.slice(0, 5)} ${digits.slice(5)}` : (raw ?? "");
}
