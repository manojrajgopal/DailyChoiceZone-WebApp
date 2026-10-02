import { afterEach, describe, expect, it } from "vitest";

import type { CurrencyConfig } from "@/types";

import {
  allocate,
  clampTo,
  currency,
  discountOf,
  formatMoney,
  formatMoneyNumber,
  percentOf,
  setCurrency,
  sum,
  taxIncludedIn,
  toMajor,
  toMinor,
} from "./money";

const INR: CurrencyConfig = { code: "INR", symbol: "₹", locale: "en-IN", decimals: 2 };
const JPY: CurrencyConfig = { code: "JPY", symbol: "¥", locale: "ja-JP", decimals: 0 };
const KWD: CurrencyConfig = { code: "KWD", symbol: "KD", locale: "en-US", decimals: 3 };

afterEach(() => {
  setCurrency(INR);
});

describe("currency / setCurrency", () => {
  it("starts as INR with two decimals", () => {
    expect(currency()).toEqual(INR);
  });

  it("adopts a configured currency for every later call", () => {
    setCurrency(JPY);
    expect(currency()).toBe(JPY);
    expect(toMinor(100)).toBe(100);
    expect(formatMoney(1500)).toBe(new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(1500));
  });
});

describe("toMinor", () => {
  it.each([
    [0, 0],
    [1, 100],
    [1299, 129900],
    [0.1 + 0.2, 30],
    [19.999, 2000],
    [-5, -500],
    [-0.005, -0],
    [1e9, 1e11],
  ])("%s rupees is %s paise", (major, minor) => {
    expect(toMinor(major)).toBe(minor);
  });

  it("uses the given currency's decimals", () => {
    expect(toMinor(1.2345, KWD)).toBe(1235);
    expect(toMinor(12.6, JPY)).toBe(13);
  });

  it("is NaN for NaN", () => {
    expect(toMinor(Number.NaN)).toBeNaN();
  });
});

describe("toMajor", () => {
  it.each([
    [0, 0],
    [129900, 1299],
    [1, 0.01],
    [-250, -2.5],
  ])("%s paise is %s rupees", (minor, major) => {
    expect(toMajor(minor)).toBe(major);
  });

  it("uses the given currency's decimals", () => {
    expect(toMajor(1235, KWD)).toBe(1.235);
    expect(toMajor(13, JPY)).toBe(13);
  });
});

describe("formatMoney", () => {
  it.each([
    [0, "₹0"],
    [129900, "₹1,299"],
    [10000000000, "₹10,00,00,000"],
    [129950, "₹1,300"],
    [-50000, "-₹500"],
  ])("formats %s paise as %s without decimals by default", (minor, expected) => {
    expect(formatMoney(minor)).toBe(expected);
  });

  it.each([
    [0, "₹0.00"],
    [129999, "₹1,299.99"],
    [5, "₹0.05"],
  ])("formats %s paise as %s with decimals on an invoice", (minor, expected) => {
    expect(formatMoney(minor, { showDecimals: true })).toBe(expected);
  });
});

describe("formatMoneyNumber", () => {
  it.each([
    [129999, true, "1,299.99"],
    [129999, false, "1,300"],
    [0, true, "0.00"],
    [10000000, true, "1,00,000.00"],
  ])("formats %s paise (decimals %s) as %s with no symbol", (minor, showDecimals, expected) => {
    expect(formatMoneyNumber(minor, { showDecimals })).toBe(expected);
  });

  it("shows decimals by default", () => {
    expect(formatMoneyNumber(100)).toBe("1.00");
  });
});

describe("percentOf", () => {
  it.each([
    [10000, 10, 1000],
    [999, 50, 500], // 499.5 rounds half up
    [999, 0, 0],
    [0, 18, 0],
    [12345, 100, 12345],
    [100, 150, 150],
    [100, -10, -10],
    [1, 0.5, 0],
  ])("%s at %s%% is %s", (amount, percent, expected) => {
    expect(percentOf(amount, percent)).toBe(expected);
  });
});

describe("discountOf", () => {
  it.each([
    [10000, 10, undefined, 1000],
    [10000, 10, 500, 500],
    [10000, 10, 2000, 1000],
    [10000, 150, undefined, 10000], // never more than the amount
    [10000, -10, undefined, 0], // never negative
    [10000, 10, 0, 0],
    [0, 50, undefined, 0],
  ])("%s at %s%% capped at %s is %s", (amount, percent, cap, expected) => {
    expect(discountOf(amount, percent, cap)).toBe(expected);
  });
});

describe("allocate", () => {
  it.each([
    [100, [1, 1, 1], [34, 33, 33]],
    [100, [1, 2], [33, 67]],
    [1000, [3, 3, 4], [300, 300, 400]],
    [0, [1, 2, 3], [0, 0, 0]],
    [5, [1], [5]],
    [1, [1, 1, 1], [1, 0, 0]],
    [10, [0, 1], [0, 10]],
  ])("splits %s across %j as %j", (amount, weights, expected) => {
    const parts = allocate(amount, weights);
    expect(parts).toEqual(expected);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
  });

  it("always sums exactly back to the amount for awkward weights", () => {
    const weights = [0.3, 0.3, 0.3, 1.7, 2.9];
    const parts = allocate(9999, weights);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(9999);
  });

  it.each([
    [100, [], []],
    [100, [0, 0], [0, 0]],
    [100, [-1, 1], [0, 0]],
  ])("is all zeros when the weights total nothing (%s, %j)", (amount, weights, expected) => {
    expect(allocate(amount, weights)).toEqual(expected);
  });
});

describe("taxIncludedIn", () => {
  it.each([
    [11800, 18, 10000, 1800],
    [10500, 5, 10000, 500],
    [999, 12, 892, 107],
    [0, 18, 0, 0],
    [10000, 0, 10000, 0],
    [10000, -5, 10000, 0],
  ])("%s gross at %s%% is %s net + %s tax", (gross, rate, net, tax) => {
    const result = taxIncludedIn(gross, rate);
    expect(result).toEqual({ net, tax });
    expect(result.net + result.tax).toBe(gross);
  });
});

describe("clampTo", () => {
  it.each([
    [50, 100, 50],
    [150, 100, 100],
    [-5, 100, 0],
    [0, 0, 0],
    [10, -5, 0],
  ])("clamps %s to [0, %s] as %s", (value, max, expected) => {
    expect(clampTo(value, max)).toBe(expected);
  });
});

describe("sum", () => {
  it.each([
    [[], 0],
    [[5], 5],
    [[1, 2, 3], 6],
    [[100, -40], 60],
  ])("sums %j to %s", (values, expected) => {
    expect(sum(values)).toBe(expected);
  });
});
