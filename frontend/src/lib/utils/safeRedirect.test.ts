import { describe, expect, it } from "vitest";

import { safeRedirect } from "./safeRedirect";

describe("safeRedirect", () => {
  describe("accepted paths", () => {
    it.each([
      ["/checkout", "/checkout"],
      ["/checkout?step=2#pay", "/checkout?step=2#pay"],
      ["%2Fcheckout%3Fstep%3D2", "/checkout?step=2"],
      ["/a/../b", "/b"],
      ["/", "/"],
      ["/shop/kurta%20set", "/shop/kurta%20set"],
    ])("%j goes to %j", (target, expected) => {
      expect(safeRedirect(target)).toBe(expected);
    });
  });

  describe("rejected values fall back", () => {
    it.each([
      [null],
      [undefined],
      [""],
      ["https://evil.example"],
      ["javascript:alert(1)"],
      ["//evil.example"],
      ["/\\evil.example"],
      ["%2F%2Fevil.example"],
      ["/\t/evil.example"],
      ["/%0a/evil"],
      ["/x\u007f"],
      ["%E0%A4%A"],
      ["checkout"],
    ])("%j falls back to /account", (target) => {
      expect(safeRedirect(target)).toBe("/account");
    });

    it("decodes only once, so a double-encoded slash stays encoded and harmless", () => {
      expect(safeRedirect("/%252F%252Fevil")).toBe("/%2F%2Fevil");
    });

    it("uses a custom fallback", () => {
      expect(safeRedirect("//evil", "/home")).toBe("/home");
      expect(safeRedirect(undefined, "/admin")).toBe("/admin");
    });
  });
});
