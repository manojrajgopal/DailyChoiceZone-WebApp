import type { BillingConfig } from "@/types";

import { setCurrency } from "@/lib/money";
import { apiGet, apiPut } from "@/services/api/client";

/**
 * Billing configuration.
 *
 * What is left of this file is *configuration*, not arithmetic. The seller's
 * legal details, the currency, the invoice wording, the refund reasons — the
 * things a document is printed with.
 *
 * **The arithmetic moved to the server**, which is the whole point. Subtotals,
 * coupon apportionment, delivery, tax and the grand total are worked out once,
 * in `services/billing.py`, by the same code that charges the card and writes
 * the invoice. This file used to do all of that as well, and two
 * implementations of the same sum is exactly how a cart comes to quote a total
 * the checkout disagrees with.
 *
 * Numbering went with it. An invoice number minted in a browser is a number two
 * tabs can mint twice; sequential, gapless numbering is a property only a
 * single authority can provide.
 */

/**
 * Read once per page load.
 *
 * It changes a handful of times a year and every invoice needs it, so fetching
 * it per render would be a request per document for a document that never
 * differs. `saveBillingConfig` clears it, so the settings page sees its own
 * change immediately.
 */
let cached: Promise<BillingConfig> | null = null;

export function getBillingConfig(): Promise<BillingConfig> {
  cached ??= apiGet<BillingConfig>("/site/billing-config").then(adopt);
  return cached;
}

export async function saveBillingConfig(config: BillingConfig): Promise<BillingConfig> {
  const saved = adopt(
    await apiPut<BillingConfig>("/admin/settings/billing", config, { auth: "admin" }),
  );
  cached = Promise.resolve(saved);
  return saved;
}

/**
 * Hand the currency to `formatMoney`.
 *
 * It formats from a render function and cannot await anything, so it holds the
 * currency as module state and this is what sets it. Doing it here means one
 * fetch answers both questions rather than two places each having a copy.
 */
function adopt(config: BillingConfig): BillingConfig {
  if (config.currency) setCurrency(config.currency);
  return config;
}
