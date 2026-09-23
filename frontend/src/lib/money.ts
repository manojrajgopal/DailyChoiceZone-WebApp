import billingConfigJson from "@/data/billing/billing-config.json";

import type { BillingConfig, CurrencyConfig, Money } from "@/types";

/**
 * Money arithmetic.
 *
 * Every amount in the billing domain is an **integer in the currency's minor
 * unit** — paise for INR. Not rupees, and never a float.
 *
 * The reason is the one every billing system eventually learns: `0.1 + 0.2` is
 * not `0.3` in binary floating point, and a rounding error of a hundredth of a
 * rupee per line becomes a figure that does not add up by the time it reaches
 * an invoice. Integers cannot drift. The only place fractions appear is
 * formatting, at the very edge.
 *
 * The catalogue still prices in whole rupees, because that is what it sells in.
 * `toMinor` is the boundary between the two, and it is exact: a whole rupee is
 * always a whole number of paise.
 *
 * Nothing here is currency-specific beyond the configuration it reads, so
 * supporting a second currency means adding an entry to `billing-config.json`,
 * not editing this file.
 */

const CONFIG = billingConfigJson as BillingConfig;

export function currency(): CurrencyConfig {
  return CONFIG.currency;
}

/** Rupees (or any major unit) to minor units. `1299` → `129900`. */
export function toMinor(major: number, config: CurrencyConfig = currency()): Money {
  return Math.round(major * 10 ** config.decimals);
}

/** Minor units back to major, as a fraction. For display and export only. */
export function toMajor(minor: Money, config: CurrencyConfig = currency()): number {
  return minor / 10 ** config.decimals;
}

/**
 * Format an amount for display.
 *
 * `decimals` controls the stored precision; `showDecimals` controls whether
 * they are printed. Indian retail prices are whole rupees, so the default hides
 * a trailing `.00` that would only add noise — but an invoice asks for them,
 * because a document people file needs to show exactly what was charged.
 */
export function formatMoney(
  minor: Money,
  { showDecimals = false }: { showDecimals?: boolean } = {},
): string {
  const config = currency();
  const fractionDigits = showDecimals ? config.decimals : 0;

  return new Intl.NumberFormat(config.locale, {
    style: "currency",
    currency: config.code,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(toMajor(minor, config));
}

/** The same amount with the symbol rendered separately. */
export function formatMoneyNumber(minor: Money, { showDecimals = true } = {}): string {
  const config = currency();
  const fractionDigits = showDecimals ? config.decimals : 0;
  return new Intl.NumberFormat(config.locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(toMajor(minor, config));
}

/**
 * A percentage of an amount, rounded half-up to the minor unit.
 *
 * Half-up rather than banker's rounding because that is what Indian invoices
 * and every accountant checking one expect.
 */
export function percentOf(amount: Money, percent: number): Money {
  return Math.round((amount * percent) / 100);
}

/** A discount of `percent`, never more than the amount itself. */
export function discountOf(amount: Money, percent: number, cap?: Money): Money {
  const raw = percentOf(amount, percent);
  const capped = typeof cap === "number" ? Math.min(raw, cap) : raw;
  return clampTo(capped, amount);
}

/**
 * Split an amount across weights so the parts sum **exactly** back to it.
 *
 * Rounding each share independently loses or gains a paisa or two, and an
 * invoice whose lines do not add up to its total is an invoice nobody trusts.
 * The largest-remainder method hands the leftover minor units to the shares
 * that were rounded down hardest, which is both fair and exact.
 *
 * This is what apportions an order-level coupon across the lines it discounted.
 */
export function allocate(amount: Money, weights: number[]): Money[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || weights.length === 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (amount * weight) / total);
  const floors = exact.map((value) => Math.floor(value));
  let remainder = amount - floors.reduce((sum, value) => sum + value, 0);

  // Hand the leftover units to the largest fractional parts, biggest first.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  const result = [...floors];
  for (const { index } of order) {
    if (remainder <= 0) break;
    result[index] = (result[index] ?? 0) + 1;
    remainder -= 1;
  }

  return result;
}

/**
 * Extract the tax already contained in a tax-inclusive amount.
 *
 * `gross = net × (1 + rate)`, so `net = gross ÷ (1 + rate)` and the tax is what
 * is left over. Deriving the tax as the remainder rather than computing it
 * directly guarantees `net + tax === gross` with no stray paisa.
 */
export function taxIncludedIn(gross: Money, ratePercent: number): { net: Money; tax: Money } {
  if (ratePercent <= 0) return { net: gross, tax: 0 };
  const net = Math.round((gross * 100) / (100 + ratePercent));
  return { net, tax: gross - net };
}

export function clampTo(value: Money, max: Money): Money {
  return Math.max(0, Math.min(value, max));
}

export function sum(values: Money[]): Money {
  return values.reduce((total, value) => total + value, 0);
}
