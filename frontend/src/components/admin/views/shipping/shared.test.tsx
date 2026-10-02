import { describe, expect, it, vi } from "vitest";

import { renderUI, screen } from "@/test/render";

import {
  EMPTY_PACKAGE,
  PackageFields,
  ShipmentStatusBadge,
  addressLines,
  formatEta,
  packageForm,
  validatePackage,
  type PackageForm,
} from "./shared";

const form = (overrides: Partial<PackageForm> = {}): PackageForm => ({
  weightGrams: "800",
  lengthCm: "30",
  widthCm: "20",
  heightCm: "5",
  count: "1",
  type: "box",
  ...overrides,
});

describe("ShipmentStatusBadge", () => {
  it.each([
    ["ready-for-pickup", "Ready for pickup"],
    ["out-for-delivery", "Out for delivery"],
    ["returned-to-origin", "Returned to origin"],
    ["cancelled", "Cancelled"],
  ])("labels %s as %s", (status, label) => {
    renderUI(<ShipmentStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("prefers the server's label and falls back to the raw status for an unknown one", () => {
    const { rerender } = renderUI(<ShipmentStatusBadge status="in-transit" label="On its way" />);
    expect(screen.getByText("On its way")).toBeInTheDocument();
    rerender(<ShipmentStatusBadge status="teleported" />);
    expect(screen.getByText("teleported")).toBeInTheDocument();
  });
});

describe("formatEta", () => {
  it.each([
    [null, ""],
    [undefined, ""],
    [1, "1 day"],
    [3, "3 days"],
    [{ min: 1, max: 1 }, "1 day"],
    [{ min: 4, max: 4 }, "4 days"],
    [{ min: 2, max: 4 }, "2–4 days"],
  ] as const)("formats %j as %j", (eta, text) => {
    expect(formatEta(eta)).toBe(text);
  });
});

describe("addressLines", () => {
  it("joins street and place and skips what's blank", () => {
    expect(
      addressLines({ name: "Asha Rao", phone: "9876543210", line1: "4 Lake View", line2: "", city: "Mysuru", state: "Karnataka", pincode: "570001" }),
    ).toEqual(["Asha Rao", "4 Lake View", "Mysuru, Karnataka 570001", "9876543210"]);
  });

  it("includes line 2 and drops whitespace-only parts", () => {
    expect(addressLines({ name: " ", line1: "12 Mill Road", line2: "Floor 2", city: "", state: "", pincode: "560001" })).toEqual([
      "12 Mill Road, Floor 2",
      "560001",
    ]);
  });

  it("is empty for no address", () => {
    expect(addressLines(null)).toEqual([]);
    expect(addressLines(undefined)).toEqual([]);
  });
});

describe("packageForm", () => {
  it("prefills from what the server holds, as text", () => {
    expect(packageForm({ weightGrams: 800, lengthCm: 30, widthCm: 20, heightCm: 5, count: 1, type: "box" })).toEqual(form());
  });

  it("leaves blank fields blank instead of making anything up", () => {
    expect(packageForm(null)).toEqual(EMPTY_PACKAGE);
    expect(packageForm({ weightGrams: 500 })).toEqual({ ...EMPTY_PACKAGE, weightGrams: "500" });
  });
});

describe("validatePackage", () => {
  it("accepts a complete package and converts it to numbers", () => {
    expect(validatePackage(form({ lengthCm: "30.5" }), { requireAll: true })).toEqual({
      errors: {},
      value: { weightGrams: 800, lengthCm: 30.5, widthCm: 20, heightCm: 5, count: 1, type: "box" },
    });
  });

  it("trims what was typed", () => {
    const { errors, value } = validatePackage(form({ weightGrams: " 800 ", type: "  envelope " }), { requireAll: true });
    expect(errors).toEqual({});
    expect(value.weightGrams).toBe(800);
    expect(value.type).toBe("envelope");
  });

  it("always needs the weight", () => {
    expect(validatePackage(EMPTY_PACKAGE, { requireAll: false }).errors).toEqual({ weightGrams: "Enter the weight in grams." });
  });

  it("needs every field for an API courier", () => {
    expect(validatePackage({ ...EMPTY_PACKAGE, weightGrams: "800" }, { requireAll: true }).errors).toEqual({
      lengthCm: "Required for this courier.",
      widthCm: "Required for this courier.",
      heightCm: "Required for this courier.",
      count: "Required for this courier.",
      type: "Required for this courier.",
    });
  });

  it("needs only the weight for a manual courier, and leaves blanks out of the value", () => {
    expect(validatePackage({ ...EMPTY_PACKAGE, weightGrams: "800" }, { requireAll: false })).toEqual({
      errors: {},
      value: { weightGrams: 800 },
    });
  });

  it.each([
    ["800.5", "Use whole grams, e.g. 800."],
    ["-5", "Use whole grams, e.g. 800."],
    ["abc", "Use whole grams, e.g. 800."],
    ["0", "Between 1 and 1,00,000 grams."],
    ["100001", "Between 1 and 1,00,000 grams."],
  ])("rejects a weight of %s", (weightGrams, message) => {
    const { errors, value } = validatePackage(form({ weightGrams }), { requireAll: true });
    expect(errors.weightGrams).toBe(message);
    expect(value.weightGrams).toBeUndefined();
  });

  it("accepts the weight limits themselves", () => {
    expect(validatePackage(form({ weightGrams: "1" }), { requireAll: true }).errors).toEqual({});
    expect(validatePackage(form({ weightGrams: "100000" }), { requireAll: true }).errors).toEqual({});
  });

  it.each([
    ["abc", "Enter a number of centimetres."],
    ["1e2", "Enter a number of centimetres."],
    ["-3", "Enter a number of centimetres."],
    ["0", "Between 0.1 and 300 cm."],
    ["0.05", "Between 0.1 and 300 cm."],
    ["301", "Between 0.1 and 300 cm."],
  ])("rejects a dimension of %s", (heightCm, message) => {
    expect(validatePackage(form({ heightCm }), { requireAll: true }).errors).toEqual({ heightCm: message });
  });

  it("checks a typed dimension even when it isn't required", () => {
    expect(validatePackage(form({ widthCm: "500" }), { requireAll: false }).errors).toEqual({ widthCm: "Between 0.1 and 300 cm." });
  });

  it.each([
    ["1.5", "Use a whole number."],
    ["0", "Between 1 and 100."],
    ["101", "Between 1 and 100."],
  ])("rejects a package count of %s", (count, message) => {
    expect(validatePackage(form({ count }), { requireAll: true }).errors).toEqual({ count: message });
  });

  it("limits the package type to 40 characters", () => {
    expect(validatePackage(form({ type: "x".repeat(40) }), { requireAll: true }).errors).toEqual({});
    expect(validatePackage(form({ type: "x".repeat(41) }), { requireAll: true }).errors).toEqual({ type: "At most 40 characters." });
  });
});

describe("PackageFields", () => {
  it("shows each field with its error and reports changes", async () => {
    const onChange = vi.fn();
    const { user } = renderUI(
      <PackageFields form={EMPTY_PACKAGE} errors={{ weightGrams: "Enter the weight in grams." }} requireAll onChange={onChange} />,
    );
    const weight = screen.getByLabelText(/^Weight \(grams\)/);
    expect(weight).toBeRequired();
    expect(weight).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the weight in grams.");
    expect(screen.getByLabelText(/^Length \(cm\)/)).toBeRequired();

    await user.type(screen.getByLabelText(/^Package type/), "b");
    expect(onChange).toHaveBeenLastCalledWith({ type: "b" });
  });

  it("marks only the weight required for a manual courier, and can be disabled", () => {
    renderUI(<PackageFields form={EMPTY_PACKAGE} errors={{}} requireAll={false} disabled onChange={() => undefined} />);
    expect(screen.getByLabelText(/^Weight \(grams\)/)).toBeRequired();
    expect(screen.getByLabelText(/^Height \(cm\)/)).not.toBeRequired();
    expect(screen.getByLabelText(/^Number of packages/)).toBeDisabled();
  });
});
