import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/services/api/client";
import { renderUI, screen } from "@/test/render";

import {
  LoadFailed,
  NoAccess,
  PageSkeleton,
  PoStatusBadge,
  SupplierStatusBadge,
  isForbidden,
  isNotFound,
  newKey,
  problem,
  rupees,
  serverFieldErrors,
  todayKey,
} from "./shared";

describe("badges", () => {
  it.each([
    ["active", "Active"],
    ["inactive", "Inactive"],
    ["archived", "Archived"],
    ["suspended", "suspended"],
  ])("labels a %s supplier %s", (status, label) => {
    renderUI(<SupplierStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each([
    ["draft", undefined, "Draft"],
    ["partially-received", undefined, "Partially received"],
    ["received", "Fully received", "Fully received"],
    ["mystery", undefined, "mystery"],
  ])("labels a %s purchase order", (status, label, text) => {
    renderUI(<PoStatusBadge status={status} label={label} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});

describe("errors", () => {
  const forbidden = new ApiError("No", 403, "FORBIDDEN");
  const missing = new ApiError("Gone", 404, "NOT_FOUND");

  it("recognises 403 and 404 API errors only", () => {
    expect(isForbidden(forbidden)).toBe(true);
    expect(isForbidden(missing)).toBe(false);
    expect(isForbidden(Object.assign(new Error("x"), { status: 403 }))).toBe(false);
    expect(isNotFound(missing)).toBe(true);
    expect(isNotFound(null)).toBe(false);
  });

  it("uses the API's message, or the fallback", () => {
    expect(problem(missing, "Fallback")).toBe("Gone");
    expect(problem(new ApiError("", 500, "X"), "Fallback")).toBe("Fallback");
    expect(problem(new Error("raw"), "Fallback")).toBe("Fallback");
  });

  describe("serverFieldErrors", () => {
    it("maps a known code to its field", () => {
      expect(serverFieldErrors(new ApiError("That code is taken.", 409, "SUPPLIER_CODE_TAKEN"), { SUPPLIER_CODE_TAKEN: "code" })).toEqual({
        code: "That code is taken.",
      });
    });

    it("reads `details.field` on an application error", () => {
      expect(serverFieldErrors(new ApiError("Pincode must be 6 digits.", 422, "INVALID", { field: "billingAddress.pincode" }))).toEqual({
        "billingAddress.pincode": "Pincode must be 6 digits.",
      });
    });

    it("reads a request-validation list, dropping the body. prefix and falling back to the message", () => {
      const error = new ApiError("Check the form.", 422, "VALIDATION_ERROR", [
        { field: "body.items.0.quantity", message: "Too many" },
        { field: "gstin" },
        { message: "no field" },
        null,
      ]);
      expect(serverFieldErrors(error)).toEqual({ "items.0.quantity": "Too many", gstin: "Check the form." });
    });

    it("is empty for anything else", () => {
      expect(serverFieldErrors(new Error("x"))).toEqual({});
      expect(serverFieldErrors(new ApiError("Nope", 500, "INTERNAL", "a string"))).toEqual({});
    });
  });
});

describe("states", () => {
  it("explains a missing suppliers or purchasing permission", () => {
    const { rerender } = renderUI(<NoAccess area="suppliers" />);
    expect(screen.getByText("Your role doesn't include suppliers")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the dashboard" })).toHaveAttribute("href", "/admin/dashboard");
    rerender(<NoAccess area="purchasing" />);
    expect(screen.getByText("Your role doesn't include purchasing")).toBeInTheDocument();
    expect(screen.getByText(/the purchasing permission/)).toBeInTheDocument();
  });

  it("shows a load failure with a retry", async () => {
    const onRetry = vi.fn();
    const { user, rerender } = renderUI(<LoadFailed message="Down for maintenance." onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Down for maintenance.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<LoadFailed onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This didn’t load.");
  });

  it("labels the skeleton", () => {
    renderUI(<PageSkeleton label="Loading supplier" />);
    expect(screen.getByLabelText("Loading supplier")).toHaveAttribute("aria-busy", "true");
  });
});

describe("helpers", () => {
  it("formats rupees with paise only when there are any", () => {
    expect(rupees(125000)).toBe("₹1,25,000");
    expect(rupees(562.5)).toBe("₹562.50");
  });

  it("gives today's date in the store's clock, not UTC", () => {
    // 20:00 UTC on the 1st is already the 2nd in India.
    expect(todayKey(new Date("2026-10-01T20:00:00Z"))).toBe("2026-10-02");
    expect(todayKey(new Date("2026-10-01T10:00:00Z"))).toBe("2026-10-01");
  });

  it("makes a fresh key each time, even without crypto.randomUUID", () => {
    expect(newKey()).not.toBe(newKey());
    vi.stubGlobal("crypto", {});
    const a = newKey();
    const b = newKey();
    expect(a).toMatch(/^k-/);
    expect(a).not.toBe(b);
  });
});
