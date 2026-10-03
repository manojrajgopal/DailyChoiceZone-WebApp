import { describe, expect, it } from "vitest";

import { convert, convertCell, formatCell, round } from "./units";

describe("size-guide units", () => {
  it("converts with exact factors", () => {
    expect(convert(2.54, "cm", "in")).toBeCloseTo(1, 12);
    expect(convert(1, "in", "mm")).toBeCloseTo(25.4, 12);
    expect(convert(92, "cm", "cm")).toBe(92);
  });

  it.each([
    [92, 36.2],
    [97, 38.2],
    [70, 27.6],
    [100, 39.4],
  ])("%d cm reads %d in, rounded once", (cm, inches) => {
    expect(round(convert(cm, "cm", "in"), "in")).toBe(inches);
  });

  it("rounds halves up, like the server", () => {
    expect(round(36.25, "in")).toBe(36.3);
    expect(round(12.5, "mm")).toBe(13);
  });

  it("converts from the stored value, so switching back shows the original", () => {
    const stored = { min: 92, max: 97 };
    const inches = convertCell(stored, "cm", "in");
    expect(inches).toEqual({ min: 36.2, max: 38.2 });
    // The display converts from `stored` each time, never from `inches`.
    expect(convertCell(stored, "cm", "cm")).toEqual({ min: 92, max: 97 });
  });

  it("formats single values and ranges", () => {
    expect(formatCell({ min: 92 }, "cm")).toBe("92 cm");
    expect(formatCell({ min: 36.2, max: 38.2 }, "in")).toBe("36.2–38.2 in");
    expect(formatCell({ min: 16.5, max: 16.5 }, "mm")).toBe("17 mm");
  });
});
