import type { Money, TaxBreakdown, TaxConfig, TaxMode } from "@/types";

import { percentOf, taxIncludedIn } from "@/lib/money";
import { apiGet, apiPut } from "@/services/api/client";

/**
 * Tax configuration, and one preview calculation.
 *
 * **The tax that gets charged is computed on the server**, in
 * `services/billing.py`, per line, at the moment an order is placed — and
 * again, from the stored invoice, whenever a refund or a credit note is
 * raised. Nothing a browser works out is trusted, and nothing here is filed.
 *
 * What is left is the configuration, read from the API, plus `calculateTax`
 * for the one screen that needs to show a split *before* it commits: the
 * credit-note dialog, where whoever is issuing it wants to see what the
 * amount they typed breaks down into. The server recomputes it on submit and
 * its answer is the one that is stored — this is a preview, and is documented
 * as one so nobody reaches for it as an authority.
 *
 * **Scope, stated plainly:** a configurable representation of Indian GST, not
 * a compliance implementation. Real treatment depends on HSN classification,
 * exemptions and thresholds, reverse charge and place-of-supply rules that
 * belong with professional advice.
 */

/** Read once per page load; `saveTaxConfig` refreshes it. */
let cached: Promise<TaxConfig> | null = null;

export function getTaxConfig(): Promise<TaxConfig> {
  cached ??= apiGet<TaxConfig>("/site/tax-config");
  return cached;
}

export async function saveTaxConfig(config: TaxConfig): Promise<TaxConfig> {
  const saved = await apiPut<TaxConfig>("/admin/settings/tax", config, { auth: "admin" });
  cached = Promise.resolve(saved);
  return saved;
}

/**
 * Which tax applies, given where the goods are going.
 *
 * Supply inside the seller's own state is split between the centre and the
 * state; supply across a state line is a single integrated tax. Comparison is
 * case- and space-insensitive because addresses are typed by people.
 */
export function taxModeFor(placeOfSupply: string, config: TaxConfig): TaxMode {
  if (!config.enabled || config.taxType === "NONE") return "none";
  const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalise(placeOfSupply) === normalise(config.originState)
    ? "intra-state"
    : "inter-state";
}

/** The rates for a category, falling back to the default set. */
export function ratesFor(category: string | null, config: TaxConfig) {
  if (category && config.categoryRates?.[category]) return config.categoryRates[category];
  return config.rates;
}

/** The single combined percentage that applies, for labels and the IGST case. */
export function combinedRate(
  mode: TaxMode,
  category: string | null,
  config: TaxConfig,
): number {
  if (mode === "none") return 0;
  const rates = ratesFor(category, config);
  return mode === "intra-state" ? rates.cgst + rates.sgst : rates.igst;
}

/**
 * Preview the tax on an amount.
 *
 * Mirrors `calculate_tax` in the backend deliberately — same extraction, same
 * halving, same rounding — so a preview and the stored document agree. It is
 * still a preview: the server does not read this, and if the two ever diverge
 * the server is right.
 *
 * When prices are tax-inclusive the tax is *extracted*: the customer pays what
 * the shelf said, and the document shows how that splits. CGST and SGST are
 * derived by halving the *total*, not the rate, so the two parts always sum
 * back to the whole with no stray paisa.
 */
export function calculateTax(
  amount: Money,
  placeOfSupply: string,
  category: string | null,
  config: TaxConfig,
): TaxBreakdown {
  const mode = taxModeFor(placeOfSupply, config);

  if (mode === "none" || amount <= 0) {
    return { ...EMPTY_TAX, taxableAmount: Math.max(0, amount) };
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

export const EMPTY_TAX: TaxBreakdown = {
  mode: "none",
  taxableAmount: 0,
  cgst: 0,
  sgst: 0,
  igst: 0,
  totalTax: 0,
  ratePercent: 0,
};
