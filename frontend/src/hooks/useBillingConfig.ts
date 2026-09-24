"use client";

import { useEffect, useState } from "react";

import type { BillingConfig, TaxConfig } from "@/types";

import { getBillingConfig } from "@/services/billing/billingService";
import { getTaxConfig } from "@/services/billing/taxService";

/**
 * The billing and tax configuration, for the screens that print it.
 *
 * Both come from the server now, so they arrive a tick late. Null until then —
 * callers render the surrounding page and leave the document's header blank
 * for that tick, which is preferable to shipping a second copy of the seller's
 * details in the bundle so it can be shown a moment sooner.
 *
 * The services cache the request, so a page with two of these hooks makes one
 * call.
 */

function useConfig<T>(load: () => Promise<T>): T | null {
  const [config, setConfig] = useState<T | null>(null);

  useEffect(() => {
    let active = true;
    load()
      .then((result) => {
        if (active) setConfig(result);
      })
      .catch(() => {
        /* the page renders without it */
      });
    return () => {
      active = false;
    };
    // `load` is a module function; re-running on its identity would be a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return config;
}

export function useBillingConfig(): BillingConfig | null {
  return useConfig(getBillingConfig);
}

export function useTaxConfig(): TaxConfig | null {
  return useConfig(getTaxConfig);
}

/** The reasons offered in the refund and credit-note dialogs. */
export function useRefundReasons(): string[] {
  return useBillingConfig()?.refund.reasons ?? [];
}
