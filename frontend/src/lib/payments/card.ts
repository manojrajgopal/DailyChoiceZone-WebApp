/**
 * Card details, checked in the browser before they are handed to the gateway.
 *
 * These checks are about the shopper's typing — a digit missed, an expiry in
 * the past — so the form can say so before anything is sent. They decide
 * nothing about the card itself: the issuing bank does that, through the
 * gateway, and its answer is the only one that counts.
 *
 * ## Where card details go, and where they never go
 *
 * From the form's own state straight to Razorpay (`createPayment`, over TLS
 * to Razorpay's servers). Never to this application's server, never into any
 * store, local storage, cookie, URL, log, analytics event or error report.
 * The form clears them once a payment has been started. See
 * docs/payments-in-our-ui.md for the PCI-DSS implications of this choice.
 */

export type CardBrand = "visa" | "mastercard" | "rupay" | "amex" | "diners" | "discover" | "jcb" | "maestro" | "unknown";

interface BrandRule {
  brand: CardBrand;
  /** Prefix ranges, inclusive, compared on the leading digits. */
  ranges: [string, string][];
  lengths: number[];
  cvv: number;
  /** Where the spaces go when the number is shown: group sizes. */
  groups: number[];
}

// Checked in order: narrower ranges (Discover's 6011, JCB's 35xx) come before
// the broad ones they overlap with (RuPay's 60, Maestro's 6x).
const RULES: BrandRule[] = [
  { brand: "amex", ranges: [["34", "34"], ["37", "37"]], lengths: [15], cvv: 4, groups: [4, 6, 5] },
  { brand: "diners", ranges: [["300", "305"], ["36", "36"], ["38", "39"]], lengths: [14, 16], cvv: 3, groups: [4, 6, 4] },
  { brand: "discover", ranges: [["6011", "6011"], ["644", "649"]], lengths: [16, 19], cvv: 3, groups: [4, 4, 4, 4, 3] },
  { brand: "jcb", ranges: [["3528", "3589"]], lengths: [16, 17, 18, 19], cvv: 3, groups: [4, 4, 4, 4, 3] },
  // RuPay: India's own network, mostly 60, 65, 81, 82 and 508.
  { brand: "rupay", ranges: [["60", "60"], ["65", "65"], ["81", "82"], ["508", "508"]],
    lengths: [16], cvv: 3, groups: [4, 4, 4, 4] },
  { brand: "mastercard", ranges: [["51", "55"], ["2221", "2720"]], lengths: [16], cvv: 3, groups: [4, 4, 4, 4] },
  { brand: "maestro", ranges: [["50", "50"], ["56", "58"], ["61", "69"]], lengths: [12, 13, 14, 15, 16, 17, 18, 19],
    cvv: 3, groups: [4, 4, 4, 4, 3] },
  { brand: "visa", ranges: [["4", "4"]], lengths: [13, 16, 19], cvv: 3, groups: [4, 4, 4, 4, 3] },
];

const UNKNOWN: BrandRule = { brand: "unknown", ranges: [], lengths: [12, 13, 14, 15, 16, 17, 18, 19], cvv: 3,
  groups: [4, 4, 4, 4, 3] };

export const BRAND_NAMES: Record<CardBrand, string> = {
  visa: "Visa", mastercard: "Mastercard", rupay: "RuPay", amex: "American Express", diners: "Diners Club",
  discover: "Discover", jcb: "JCB", maestro: "Maestro", unknown: "Card",
};

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function matches(number: string, [low, high]: [string, string]): boolean {
  const head = number.slice(0, low.length);
  if (head.length < low.length) {
    // Still typing: does what's there so far fit the range?
    return head >= low.slice(0, head.length) && head <= high.slice(0, head.length);
  }
  return head >= low && head <= high;
}

function ruleFor(number: string): BrandRule {
  const digits = digitsOnly(number);
  if (!digits) return UNKNOWN;
  return RULES.find((rule) => rule.ranges.some((range) => matches(digits, range))) ?? UNKNOWN;
}

export function cardBrand(number: string): CardBrand {
  return ruleFor(number).brand;
}

/** "4111 1111 1111 1111", grouped as that brand prints it; at most the longest length. */
export function formatCardNumber(value: string): string {
  const rule = ruleFor(value);
  const digits = digitsOnly(value).slice(0, Math.max(...rule.lengths));
  const parts: string[] = [];
  let at = 0;
  for (const size of rule.groups) {
    if (at >= digits.length) break;
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  if (at < digits.length) parts.push(digits.slice(at));
  return parts.join(" ");
}

/** The Luhn check digit, which catches nearly every single mistyped or swapped digit. */
export function passesLuhn(number: string): boolean {
  const digits = digitsOnly(number);
  if (digits.length < 12) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** "MM / YY" as it is typed: digits only, the slash added for them. */
export function formatExpiry(value: string): string {
  let digits = digitsOnly(value).slice(0, 4);
  // A lone "2"–"9" can only be a month: make it "02"–"09".
  if (digits.length === 1 && Number(digits) > 1) digits = `0${digits}`;
  return digits.length > 2 ? `${digits.slice(0, 2)} / ${digits.slice(2)}` : digits;
}

export function parseExpiry(value: string): { month: number; year: number } | null {
  const digits = digitsOnly(value);
  if (digits.length !== 4) return null;
  const month = Number(digits.slice(0, 2));
  const year = 2000 + Number(digits.slice(2));
  return month >= 1 && month <= 12 ? { month, year } : null;
}

export interface CardInput {
  number: string;
  name: string;
  expiry: string;
  cvv: string;
}

export type CardErrors = Partial<Record<keyof CardInput, string>>;

/** What's wrong with the card details as typed, field by field. Empty when they can be sent. */
export function validateCard(input: CardInput, now: Date = new Date()): CardErrors {
  const errors: CardErrors = {};
  const rule = ruleFor(input.number);
  const digits = digitsOnly(input.number);

  if (!digits) errors.number = "Enter your card number.";
  else if (!rule.lengths.includes(digits.length) || !passesLuhn(digits)) {
    errors.number = "Check your card number — it doesn't look right.";
  }

  const name = input.name.trim();
  if (name.length < 2) errors.name = "Enter the name on your card.";
  else if (!/^[\p{L} .'-]{2,60}$/u.test(name)) errors.name = "Use letters only, as printed on the card.";

  const expiry = parseExpiry(input.expiry);
  if (!expiry) errors.expiry = "Enter the expiry date as MM / YY.";
  else {
    // A card is valid to the end of its expiry month.
    const endOfMonth = new Date(expiry.year, expiry.month, 1);
    if (endOfMonth <= now) errors.expiry = "This card has expired.";
    else if (expiry.year > now.getFullYear() + 20) errors.expiry = "Check the expiry year.";
  }

  const cvv = digitsOnly(input.cvv);
  if (cvv.length !== rule.cvv && !(rule.brand === "unknown" && cvv.length === 4)) {
    errors.cvv = rule.cvv === 4 ? "Enter the 4-digit code on the front of the card." : "Enter the 3-digit code on the back.";
  }
  return errors;
}

/** The shape the gateway takes. Built at the moment of paying and not kept. */
export interface CardDetails {
  number: string;
  name: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
}

export function toCardDetails(input: CardInput): CardDetails {
  const expiry = parseExpiry(input.expiry)!;
  return {
    number: digitsOnly(input.number),
    name: input.name.trim(),
    expiryMonth: String(expiry.month).padStart(2, "0"),
    expiryYear: String(expiry.year % 100).padStart(2, "0"),
    cvv: digitsOnly(input.cvv),
  };
}

/** "•••• 4242" — the most a card number is ever shown as once typed. */
export function maskedNumber(number: string): string {
  const digits = digitsOnly(number);
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "";
}

export function cvvLength(number: string): number {
  return ruleFor(number).cvv;
}
