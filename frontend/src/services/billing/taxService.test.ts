import { afterEach, describe, expect, it } from "vitest";

import type { TaxConfig } from "@/types";
import { api } from "@/test/api";

import {
  EMPTY_TAX,
  calculateTax,
  combinedRate,
  getTaxConfig,
  ratesFor,
  saveTaxConfig,
  taxModeFor,
} from "./taxService";

function makeTaxConfig(overrides: Partial<TaxConfig> = {}): TaxConfig {
  return {
    enabled: true,
    taxType: "GST",
    pricesIncludeTax: false,
    originState: "Karnataka",
    gstin: "29ABCDE1234F2Z5",
    rates: { cgst: 9, sgst: 9, igst: 18 },
    ...overrides,
  };
}

describe("taxModeFor", () => {
  const config = makeTaxConfig();

  it.each([
    ["Karnataka", "intra-state"],
    ["karnataka", "intra-state"],
    ["  Karnataka  ", "intra-state"],
    ["Maharashtra", "inter-state"],
  ])("%s against origin Karnataka is %s", (place, expected) => {
    expect(taxModeFor(place, config)).toBe(expected);
  });

  it("is 'none' when tax is disabled", () => {
    expect(taxModeFor("Karnataka", makeTaxConfig({ enabled: false }))).toBe("none");
  });

  it("is 'none' when taxType is NONE", () => {
    expect(taxModeFor("Karnataka", makeTaxConfig({ taxType: "NONE" }))).toBe("none");
  });
});

describe("ratesFor", () => {
  const config = makeTaxConfig({ categoryRates: { electronics: { cgst: 6, sgst: 6, igst: 12 } } });

  it("uses a category override when present", () => {
    expect(ratesFor("electronics", config)).toEqual({ cgst: 6, sgst: 6, igst: 12 });
  });

  it("falls back to the default rates for an unknown category", () => {
    expect(ratesFor("furniture", config)).toEqual({ cgst: 9, sgst: 9, igst: 18 });
  });

  it("falls back to default rates for a null category", () => {
    expect(ratesFor(null, config)).toEqual({ cgst: 9, sgst: 9, igst: 18 });
  });
});

describe("combinedRate", () => {
  const config = makeTaxConfig();

  it.each([
    ["none", null, 0],
    ["intra-state", null, 18],
    ["inter-state", null, 18],
  ] as const)("mode %s is %s%%", (mode, category, expected) => {
    expect(combinedRate(mode, category, config)).toBe(expected);
  });
});

describe("calculateTax", () => {
  const config = makeTaxConfig();

  it("is EMPTY_TAX (but with the amount) when tax doesn't apply", () => {
    expect(calculateTax(10000, "Karnataka", null, makeTaxConfig({ enabled: false }))).toEqual({ ...EMPTY_TAX, taxableAmount: 10000 });
  });

  it("is EMPTY_TAX for a zero or negative amount", () => {
    expect(calculateTax(0, "Karnataka", null, config)).toEqual({ ...EMPTY_TAX, taxableAmount: 0 });
    expect(calculateTax(-500, "Karnataka", null, config)).toEqual({ ...EMPTY_TAX, taxableAmount: 0 });
  });

  it("splits intra-state tax into CGST + SGST, extra paisa to SGST", () => {
    const result = calculateTax(10000, "Karnataka", null, config);
    expect(result).toEqual({ mode: "intra-state", taxableAmount: 10000, cgst: 900, sgst: 900, igst: 0, totalTax: 1800, ratePercent: 18 });
  });

  it("uses a single IGST for inter-state supply", () => {
    const result = calculateTax(10000, "Maharashtra", null, config);
    expect(result).toEqual({ mode: "inter-state", taxableAmount: 10000, cgst: 0, sgst: 0, igst: 1800, totalTax: 1800, ratePercent: 18 });
  });

  it("extracts tax from a tax-inclusive price rather than adding it", () => {
    const inclusive = makeTaxConfig({ pricesIncludeTax: true });
    const result = calculateTax(11800, "Karnataka", null, inclusive);
    expect(result.taxableAmount).toBe(10000);
    expect(result.totalTax).toBe(1800);
    expect(result.taxableAmount + result.totalTax).toBe(11800);
  });

  it("uses a category's own rate when given", () => {
    const withCategory = makeTaxConfig({ categoryRates: { electronics: { cgst: 6, sgst: 6, igst: 12 } } });
    const result = calculateTax(10000, "Karnataka", "electronics", withCategory);
    expect(result.ratePercent).toBe(12);
    expect(result.totalTax).toBe(1200);
  });

  it("always sums cgst + sgst back to totalTax, even with an odd total", () => {
    const result = calculateTax(999, "Karnataka", null, config); // 999 * 18% = 179.82 -> rounds
    expect(result.cgst + result.sgst).toBe(result.totalTax);
  });
});

describe("getTaxConfig / saveTaxConfig", () => {
  afterEach(() => {
    // Nothing to invalidate across files; each test file has its own module
    // instance of the pageCache.
  });

  it("GETs the tax config and caches it for the page", async () => {
    api.get("/site/tax-config", makeTaxConfig());
    const result = await getTaxConfig();
    expect(result.originState).toBe("Karnataka");
    const before = api.requests("GET", "/site/tax-config").length;
    await getTaxConfig();
    expect(api.requests("GET", "/site/tax-config")).toHaveLength(before);
  });

  it("saveTaxConfig PUTs with admin auth and invalidates the cache", async () => {
    window.localStorage.setItem("dcz:admin-token", "adm");
    api.put("/admin/settings/tax", (req) => req.body);
    const next = makeTaxConfig({ originState: "Maharashtra" });
    const saved = await saveTaxConfig(next);
    expect(saved.originState).toBe("Maharashtra");
    expect(api.last()!.headers.authorization).toBe("Bearer adm");

    api.get("/site/tax-config", makeTaxConfig({ originState: "Maharashtra" }));
    await getTaxConfig();
    expect(api.requests("GET", "/site/tax-config")).toHaveLength(1);
  });
});
