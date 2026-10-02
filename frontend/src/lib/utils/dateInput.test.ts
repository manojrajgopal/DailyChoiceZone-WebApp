import { describe, expect, it } from "vitest";

import { endOfDay, formatLocalDate, fromServerTime, startOfDay, toDateInput } from "./dateInput";

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

describe("fromServerTime", () => {
  it.each([
    ["2026-09-29T18:30:00", "2026-09-29T18:30:00.000Z"],
    ["2026-09-29T18:30:00Z", "2026-09-29T18:30:00.000Z"],
    ["2026-09-29T18:30:00+05:30", "2026-09-29T13:00:00.000Z"],
    ["2026-09-29T18:30:00-01:00", "2026-09-29T19:30:00.000Z"],
    ["2026-12-31T23:59:59.999", "2026-12-31T23:59:59.999Z"],
  ])("reads %j as UTC (%s)", (value, iso) => {
    expect(fromServerTime(value)?.toISOString()).toBe(iso);
  });

  it.each([[null], [undefined], [""], ["not a date"]])("is null for %j", (value) => {
    expect(fromServerTime(value)).toBeNull();
  });
});

describe("toDateInput", () => {
  it.each([
    ["2026-09-28T18:30:00"],
    ["2026-12-31T23:59:59"],
    ["2026-01-01T00:00:00"],
    ["2024-02-29T12:00:00Z"],
  ])("shows %j as the local yyyy-MM-dd", (value) => {
    expect(toDateInput(value)).toBe(localDay(new Date(`${value.replace(/Z$/, "")}Z`)));
    expect(toDateInput(value)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each([[null], [undefined], [""], ["garbage"]])("is empty for %j", (value) => {
    expect(toDateInput(value)).toBe("");
  });
});

describe("startOfDay / endOfDay", () => {
  it("are the first and last local moments of the picked day, as UTC ISO", () => {
    expect(startOfDay("2026-09-29")).toBe(new Date(2026, 8, 29, 0, 0, 0, 0).toISOString());
    expect(endOfDay("2026-09-30")).toBe(new Date(2026, 8, 30, 23, 59, 59, 999).toISOString());
  });

  it("round-trip through toDateInput to the same day, across a year boundary", () => {
    expect(toDateInput(startOfDay("2026-12-31"))).toBe("2026-12-31");
    expect(toDateInput(endOfDay("2026-12-31"))).toBe("2026-12-31");
    expect(toDateInput(startOfDay("2027-01-01"))).toBe("2027-01-01");
  });

  it("span almost exactly one day", () => {
    const start = new Date(startOfDay("2026-03-15")!).getTime();
    const end = new Date(endOfDay("2026-03-15")!).getTime();
    expect(end - start).toBeGreaterThanOrEqual(23 * 3600_000);
    expect(end - start).toBeLessThan(25 * 3600_000);
  });

  it("are null for an empty picker", () => {
    expect(startOfDay("")).toBeNull();
    expect(endOfDay("")).toBeNull();
  });
});

describe("formatLocalDate", () => {
  it("formats a server timestamp as a readable local date", () => {
    const value = "2026-09-30T06:00:00";
    expect(formatLocalDate(value)).toBe(
      new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}Z`)),
    );
    expect(formatLocalDate(value)).toMatch(/30 Sept? 2026/);
  });

  it.each([[null], [undefined], [""], ["nope"]])("is empty for %j", (value) => {
    expect(formatLocalDate(value)).toBe("");
  });
});
