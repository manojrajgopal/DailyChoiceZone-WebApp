import { describe, expect, it } from "vitest";

import { formatMobile, normaliseMobile, sameMobile } from "./phone";

describe("phone", () => {
  it.each([
    ["98765 43210", "9876543210"],
    ["+91 98765-43210", "9876543210"],
    ["+919876543210", "9876543210"],
    ["09876543210", "9876543210"],
  ])("normalises %s", (raw, digits) => {
    expect(normaliseMobile(raw)).toBe(digits);
  });

  it.each(["12345", "5876543210", "", "abc"])("rejects %s", (raw) => {
    expect(normaliseMobile(raw)).toBeNull();
  });

  it("compares two spellings of a number", () => {
    expect(sameMobile("+919876543210", "98765 43210")).toBe(true);
    expect(sameMobile("9876543210", "9876543211")).toBe(false);
    expect(sameMobile("", "")).toBe(false);
  });

  it("formats a mobile number for display", () => {
    expect(formatMobile("+919876543210")).toBe("98765 43210");
    expect(formatMobile("+44 20 7946 0000")).toBe("+44 20 7946 0000");
  });
});
