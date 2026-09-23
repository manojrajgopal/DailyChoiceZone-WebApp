import taxConfigJson from "@/data/billing/tax-config.json";

import type { Money, TaxBreakdown, TaxConfig, TaxMode } from "@/types";

import { OVERLAY_KEYS, readDocument, writeDocument } from "@/lib/admin/mock-store";
import { percentOf, taxIncludedIn } from "@/lib/money";

/**
 * Tax.
 *
 * Every tax decision in the application is made here. Nothing else knows a
 * rate, and nothing else decides between CGST+SGST and IGST — a rate written
 * into a component is a rate nobody can find when it changes.
 *
 * **Scope, stated plainly:** this is a configurable *representation* of Indian
 * GST for a frontend demonstration. It is not a compliance implementation and
 * must not be relied on for filing. Real treatment depends on HSN
 * classification, exemptions and thresholds, reverse charge, composition
 * schemes and place-of-supply rules that belong in a backend maintained with
 * professional advice. What this gives you is the right *shape*: the numbers an
 * invoice must carry, computed in one place, ready for a server to become the
 * authority.
 *
 * Future: `GET /billing/tax-config`, `PUT /billing/tax-config`, and the
 * calculation itself moves server-side so the client cannot disagree with the
 * document that gets filed.
 */

const BASE: TaxConfig = taxConfigJson as TaxConfig;

export function getTaxConfig(): TaxConfig {
  return readDocument(OVERLAY_KEYS.taxConfig, BASE);
}

export function saveTaxConfig(config: TaxConfig): TaxConfig {
  return writeDocument(OVERLAY_KEYS.taxConfig, config);
}

/**
 * Which tax applies, given where the goods are going.
 *
 * Supply inside the seller's own state is split between the centre and the
 * state; supply across a state line is a single integrated tax. Comparison is
 * case- and space-insensitive because addresses are typed by people.
 */
export function taxModeFor(placeOfSupply: string, config: TaxConfig = getTaxConfig()): TaxMode {
  if (!config.enabled || config.taxType === "NONE") return "none";
  const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalise(placeOfSupply) === normalise(config.originState)
    ? "intra-state"
    : "inter-state";
}

/** The rates for a category, falling back to the default set. */
export function ratesFor(category: string | null, config: TaxConfig = getTaxConfig()) {
  if (category && config.categoryRates?.[category]) return config.categoryRates[category];
  return config.rates;
}

/** The single combined percentage that applies, for labels and the IGST case. */
export function combinedRate(
  mode: TaxMode,
  category: string | null = null,
  config: TaxConfig = getTaxConfig(),
): number {
  if (mode === "none") return 0;
  const rates = ratesFor(category, config);
  return mode === "intra-state" ? rates.cgst + rates.sgst : rates.igst;
}

/**
 * Work out the tax on an amount.
 *
 * `amount` is the gross consideration for the goods — the line values after
 * discounts. Whether that figure already contains the tax is configuration, not
 * an argument, because the whole catalogue has to agree on it.
 *
 * When prices are tax-inclusive the tax is *extracted*: the customer pays what
 * the shelf said, and the invoice shows how that splits. When they are
 * exclusive the tax is *added* on top. Both are common; the store's current
 * setting is inclusive, which is why applying tax does not change what anyone
 * is charged today — it only makes the composition visible.
 *
 * CGST and SGST are derived by halving the total rather than computed
 * separately, so the two halves always sum to the whole with no stray paisa.
 */
export function calculateTax(
  amount: Money,
  placeOfSupply: string,
  category: string | null = null,
  config: TaxConfig = getTaxConfig(),
): TaxBreakdown {
  const mode = taxModeFor(placeOfSupply, config);

  if (mode === "none" || amount <= 0) {
    return {
      mode: "none",
      taxableAmount: Math.max(0, amount),
      cgst: 0,
      sgst: 0,
      igst: 0,
      totalTax: 0,
      ratePercent: 0,
    };
  }

  const ratePercent = combinedRate(mode, category, config);

  const { taxableAmount, totalTax } = config.pricesIncludeTax
    ? (() => {
        const { net, tax } = taxIncludedIn(amount, ratePercent);
        return { taxableAmount: net, totalTax: tax };
      })()
    : { taxableAmount: amount, totalTax: percentOf(amount, ratePercent) };

  if (mode === "inter-state") {
    return { mode, taxableAmount, cgst: 0, sgst: 0, igst: totalTax, totalTax, ratePercent };
  }

  // Halve the *total*, not the rate, so the parts reconcile exactly.
  const cgst = Math.round(totalTax / 2);
  return {
    mode,
    taxableAmount,
    cgst,
    sgst: totalTax - cgst,
    igst: 0,
    totalTax,
    ratePercent,
  };
}

/** Add two breakdowns — used to total per-line tax into an invoice's. */
export function addTax(a: TaxBreakdown, b: TaxBreakdown): TaxBreakdown {
  return {
    // A mixed-mode invoice is impossible (one place of supply), so either
    // mode is correct; prefer the one that is actually charging something.
    mode: a.totalTax > 0 ? a.mode : b.mode,
    taxableAmount: a.taxableAmount + b.taxableAmount,
    cgst: a.cgst + b.cgst,
    sgst: a.sgst + b.sgst,
    igst: a.igst + b.igst,
    totalTax: a.totalTax + b.totalTax,
    ratePercent: a.totalTax >= b.totalTax ? a.ratePercent : b.ratePercent,
  };
}

export const EMPTY_TAX: TaxBreakdown = {
  mode: "none",
  taxableAmount: 0,
  cgst: 0,
  sgst: 0,
  igst: 0,
  totalTax: 0,
  ratePercent: 0,
};
