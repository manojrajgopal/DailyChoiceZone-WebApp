import { describe, expect, it } from "vitest";

import { api, fail } from "@/test/api";

import { PINCODE_PATTERN, checkPincode } from "./deliveryService";

describe("checkPincode", () => {
  it("GETs the pincode, URL-encoded", async () => {
    api.get("/delivery/pincodes/560001", { pincode: "560001", valid: true, serviceable: true });
    const result = await checkPincode("560001");
    expect(result).toMatchObject({ pincode: "560001", serviceable: true });
  });

  it("propagates a not-found/invalid response as a failure", async () => {
    api.get("/delivery/pincodes/000000", fail(422, "Not a valid pincode"));
    await expect(checkPincode("000000")).rejects.toMatchObject({ status: 422 });
  });
});

describe("PINCODE_PATTERN", () => {
  it.each([
    ["560001", true],
    ["110001", true],
    ["000001", false], // cannot start with 0
    ["12345", false], // too short
    ["1234567", false], // too long
    ["", false],
    ["abcdef", false],
  ])("%s is valid: %s", (value, expected) => {
    expect(PINCODE_PATTERN.test(value)).toBe(expected);
  });
});
