import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STORE_TIME_ZONE,
  deliveryEstimate,
  discountPercent,
  formatCompactINR,
  formatCompactNumber,
  formatCount,
  formatDate,
  formatNumber,
  formatPrice,
  formatSeriesLabel,
  humanize,
  slugify,
} from "./format";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatPrice", () => {
  it.each([
    [0, "₹0"],
    [1299, "₹1,299"],
    [1299.5, "₹1,300"],
    [1299.4, "₹1,299"],
    [100000, "₹1,00,000"],
    [12345678, "₹1,23,45,678"],
    [-500, "-₹500"],
  ])("%s becomes %s", (value, expected) => {
    expect(formatPrice(value)).toBe(expected);
  });

  it("prints NaN rather than throwing", () => {
    expect(formatPrice(Number.NaN)).toContain("NaN");
  });
});

describe("formatNumber", () => {
  it.each([
    [0, "0"],
    [1299, "1,299"],
    [1299.6, "1,300"],
    [100000, "1,00,000"],
    [-42, "-42"],
  ])("%s becomes %s", (value, expected) => {
    expect(formatNumber(value)).toBe(expected);
  });
});

describe("formatDate", () => {
  it("uses the store's time zone", () => {
    expect(STORE_TIME_ZONE).toBe("Asia/Kolkata");
  });

  it.each([
    // A zone-less UTC timestamp after 18:30 UTC is the next day in India.
    ["2026-09-29T18:41:58", "30 Sept 2026"],
    ["2026-09-29T18:29:59", "29 Sept 2026"],
    ["2026-09-29T18:41:58Z", "30 Sept 2026"],
    ["2026-09-29T23:00:00+05:30", "29 Sept 2026"],
    ["2026-12-31T19:00:00", "1 Jan 2027"],
    ["2026-01-31T18:30:00", "1 Feb 2026"],
  ])("timestamp %j is dated %j", (input, expected) => {
    expect(formatDate(input)).toBe(expected);
  });

  it.each([
    ["2026-10-06", "6 Oct 2026"],
    ["2026-01-01", "1 Jan 2026"],
    ["2024-02-29", "29 Feb 2024"],
  ])("bare date %j stays the calendar day %j", (input, expected) => {
    expect(formatDate(input)).toBe(expected);
  });

  it("formats Date objects and epoch numbers in IST", () => {
    expect(formatDate(new Date("2026-04-10T20:00:00Z"))).toBe("11 Apr 2026");
    expect(formatDate(Date.UTC(2026, 3, 10, 20))).toBe("11 Apr 2026");
  });

  it.each([["not a date"], [""], [Number.NaN]])("is empty for an invalid input %j", (input) => {
    expect(formatDate(input)).toBe("");
  });

  it("is empty for an invalid Date object", () => {
    expect(formatDate(new Date("x"))).toBe("");
  });
});

describe("formatCount", () => {
  it.each([
    [0, "0"],
    [438, "438"],
    [999, "999"],
    [1000, "1k"],
    [1280, "1.3k"],
    [1949, "1.9k"],
    [12000, "12k"],
    [1000000, "1000k"],
    [-5, "-5"],
  ])("%s becomes %s", (value, expected) => {
    expect(formatCount(value)).toBe(expected);
  });
});

describe("discountPercent", () => {
  it.each([
    [800, 1000, 20],
    [999, 1000, 0],
    [667, 1000, 33],
    [0, 1000, 100],
    [1000, 1000, 0],
    [1200, 1000, 0],
    [100, 0, 0],
    [100, -50, 0],
    [-100, 100, 200],
  ])("price %s off %s is %s%%", (price, original, expected) => {
    expect(discountPercent(price, original)).toBe(expected);
  });
});

describe("slugify", () => {
  it.each([
    ["Belts & Wallets", "belts-and-wallets"],
    ["  Men's  Kurta  ", "men-s-kurta"],
    ["Already-a-slug", "already-a-slug"],
    ["---x---", "x"],
    ["Ünïcode Shirt 2026", "n-code-shirt-2026"],
    ["", ""],
    ["!!!", ""],
  ])("%j becomes %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});

describe("humanize", () => {
  it.each([
    ["belts-wallets", "Belts wallets"],
    ["kurta", "Kurta"],
    ["a-b-c", "A b c"],
    ["", ""],
    ["Already", "Already"],
  ])("%j becomes %j", (input, expected) => {
    expect(humanize(input)).toBe(expected);
  });
});

describe("deliveryEstimate", () => {
  // 2 Oct 2026 is a Friday.
  const friday = new Date(2026, 9, 2, 10, 0, 0);

  it.each([
    [0, "Fri, 2 Oct"],
    [1, "Mon, 5 Oct"],
    [2, "Tue, 6 Oct"],
    [5, "Fri, 9 Oct"],
    [6, "Mon, 12 Oct"],
    [-3, "Fri, 2 Oct"],
  ])("%s business days from Friday is %s", (days, expected) => {
    expect(deliveryEstimate(days, friday)).toBe(expected);
  });

  it("crosses a month and year boundary", () => {
    expect(deliveryEstimate(1, new Date(2026, 11, 31, 9))).toBe("Fri, 1 Jan");
    expect(deliveryEstimate(3, new Date(2026, 9, 29, 9))).toBe("Tue, 3 Nov");
  });

  it("skips the weekend when starting on a Saturday", () => {
    expect(deliveryEstimate(1, new Date(2026, 9, 3, 9))).toBe("Mon, 5 Oct");
  });

  it("does not mutate the starting date", () => {
    const from = new Date(friday);
    deliveryEstimate(3, from);
    expect(from.getTime()).toBe(friday.getTime());
  });

  it("defaults to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(friday);
    expect(deliveryEstimate(1)).toBe("Mon, 5 Oct");
  });
});

describe("formatCompactINR", () => {
  it.each([
    [0, "₹0"],
    [999, "₹999"],
    [999.6, "₹1000"],
    [1000, "₹1k"],
    [85400, "₹85.4k"],
    [99999, "₹100k"],
    [100000, "₹1L"],
    [284560, "₹2.85L"],
    [250000, "₹2.50L"],
    [10000000, "₹1Cr"],
    [12345678, "₹1.23Cr"],
    [-85400, "₹-85.4k"],
    [-500, "₹-500"],
  ])("%s becomes %s", (value, expected) => {
    expect(formatCompactINR(value)).toBe(expected);
  });
});

describe("formatCompactNumber", () => {
  it.each([
    [0, "0"],
    [42.4, "42"],
    [1500, "1.5k"],
    [250000, "2.50L"], // only a trailing ".00" is trimmed, so a single trailing zero stays
    [30000000, "3Cr"],
    [-2500, "-2.5k"],
  ])("%s becomes %s", (value, expected) => {
    expect(formatCompactNumber(value)).toBe(expected);
  });
});

describe("formatSeriesLabel", () => {
  it.each([
    ["08:00", "08:00"],
    ["23:59", "23:59"],
    ["2026-09", "Sept"],
    ["2026-01", "Jan"],
    ["2026-09-18", "18 Sept"],
    ["2026-12-31", "31 Dec"],
    ["Week 3", "Week 3"],
    ["", ""],
  ])("%j becomes %j", (label, expected) => {
    expect(formatSeriesLabel(label)).toBe(expected);
  });
});
