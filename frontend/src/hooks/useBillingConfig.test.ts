import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BillingConfig, TaxConfig } from "@/types";

import { api, fail } from "@/test/api";

const BILLING = {
  business: { legalName: "Daily Choice Zone Pvt Ltd" },
  currency: { code: "INR" },
  invoice: { prefix: "INV", startNumber: 1, padding: 4, dueDays: 7, footer: "", paymentTerms: "", notes: "" },
  creditNote: { prefix: "CN", startNumber: 1, padding: 4 },
  refund: { windowDays: 7, refundShipping: false, reasons: ["Damaged", "Wrong size"] },
  payment: { enabledMethods: ["upi"], codFee: 0 },
  order: { prefix: "ORD", startNumber: 1 },
  sku: { prefix: "SKU" },
} as unknown as BillingConfig;

const TAX = {
  enabled: true,
  taxType: "gst",
  pricesIncludeTax: true,
  originState: "Kerala",
  gstin: "GSTIN123",
  rates: { cgst: 9, sgst: 9, igst: 18 },
} as unknown as TaxConfig;

/**
 * `getBillingConfig`/`getTaxConfig` cache their result for the life of the
 * module (`pageCache`), so each test resets the module graph and re-imports
 * fresh — otherwise only the first test would ever reach the fake API.
 */
async function freshHooks() {
  vi.resetModules();
  return import("./useBillingConfig");
}

describe("useBillingConfig / useTaxConfig / useRefundReasons", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("useBillingConfig is null until it arrives, then holds it", async () => {
    api.get("/site/billing-config", BILLING);
    const { useBillingConfig } = await freshHooks();
    const { result } = renderHook(() => useBillingConfig());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.refund.reasons).toEqual(["Damaged", "Wrong size"]);
  });

  it("useBillingConfig stays null on failure", async () => {
    api.get("/site/billing-config", fail(500));
    const { useBillingConfig } = await freshHooks();
    const { result } = renderHook(() => useBillingConfig());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBeNull();
  });

  it("useTaxConfig reads its own endpoint", async () => {
    api.get("/site/tax-config", TAX);
    const { useTaxConfig } = await freshHooks();
    const { result } = renderHook(() => useTaxConfig());
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.originState).toBe("Kerala");
  });

  it("useRefundReasons extracts the reasons from the billing config", async () => {
    api.get("/site/billing-config", BILLING);
    const { useRefundReasons } = await freshHooks();
    const { result } = renderHook(() => useRefundReasons());
    expect(result.current).toEqual([]);
    await waitFor(() => expect(result.current).toEqual(["Damaged", "Wrong size"]));
  });

  it("useRefundReasons is an empty array when the config never loads", async () => {
    api.get("/site/billing-config", fail(500));
    const { useRefundReasons } = await freshHooks();
    const { result } = renderHook(() => useRefundReasons());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toEqual([]);
  });
});
