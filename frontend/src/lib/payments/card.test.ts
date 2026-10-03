import { describe, expect, it } from "vitest";

import {
  cardBrand,
  formatCardNumber,
  formatExpiry,
  maskedNumber,
  parseExpiry,
  passesLuhn,
  toCardDetails,
  validateCard,
} from "./card";

const NOW = new Date(2026, 9, 2); // 2 Oct 2026

describe("card details", () => {
  it.each([
    ["4111111111111111", "visa"],
    ["5555555555554444", "mastercard"],
    ["2223003122003222", "mastercard"],
    ["378282246310005", "amex"],
    ["6074141111111111", "rupay"],
    ["6521111111111111", "rupay"],
    ["6011111111111117", "discover"],
    ["3530111333300000", "jcb"],
    ["30569309025904", "diners"],
    ["9999", "unknown"],
  ])("%s is %s", (number, brand) => {
    expect(cardBrand(number)).toBe(brand);
  });

  it("groups the number the way the brand prints it", () => {
    expect(formatCardNumber("4111111111111111")).toBe("4111 1111 1111 1111");
    expect(formatCardNumber("378282246310005")).toBe("3782 822463 10005");
    expect(formatCardNumber("4111 1111-11a")).toBe("4111 1111 11");
    expect(formatCardNumber("41111111111111119999")).toBe("4111 1111 1111 1111 999"); // capped at 19
  });

  it("checks the Luhn digit", () => {
    expect(passesLuhn("4111111111111111")).toBe(true);
    expect(passesLuhn("4111111111111112")).toBe(false);
    expect(passesLuhn("4111")).toBe(false);
  });

  it("formats and reads the expiry", () => {
    expect(formatExpiry("1")).toBe("1");
    expect(formatExpiry("3")).toBe("03");
    expect(formatExpiry("1230")).toBe("12 / 30");
    expect(parseExpiry("12 / 30")).toEqual({ month: 12, year: 2030 });
    expect(parseExpiry("13 / 30")).toBeNull();
    expect(parseExpiry("1 / 3")).toBeNull();
  });

  it("accepts a good card", () => {
    expect(validateCard({ number: "4111 1111 1111 1111", name: "Asha Rao", expiry: "10 / 26", cvv: "123" }, NOW))
      .toEqual({});
  });

  it("refuses each kind of mistake, field by field", () => {
    const errors = validateCard({ number: "4111 1111 1111 1112", name: "A", expiry: "09 / 26", cvv: "12" }, NOW);
    expect(Object.keys(errors).sort()).toEqual(["cvv", "expiry", "name", "number"]);
    expect(errors.expiry).toBe("This card has expired.");
    expect(validateCard({ number: "", name: "", expiry: "", cvv: "" }, NOW).number).toBe("Enter your card number.");
    expect(validateCard({ number: "4111111111111111", name: "Asha 9", expiry: "12/30", cvv: "123" }, NOW).name)
      .toMatch(/letters only/);
  });

  it("wants four digits for Amex and three for the rest", () => {
    const amex = { number: "378282246310005", name: "Asha Rao", expiry: "12 / 30" };
    expect(validateCard({ ...amex, cvv: "123" }, NOW).cvv).toMatch(/4-digit/);
    expect(validateCard({ ...amex, cvv: "1234" }, NOW)).toEqual({});
  });

  it("builds what the gateway takes, and masks for display", () => {
    expect(toCardDetails({ number: "4111 1111 1111 1111", name: " Asha Rao ", expiry: "03 / 29", cvv: "123" })).toEqual({
      number: "4111111111111111", name: "Asha Rao", expiryMonth: "03", expiryYear: "29", cvv: "123",
    });
    expect(maskedNumber("4111 1111 1111 1111")).toBe("•••• 1111");
  });
});
