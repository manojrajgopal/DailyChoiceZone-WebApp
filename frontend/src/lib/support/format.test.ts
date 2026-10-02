import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SlaState } from "@/services/supportService";

import {
  dayKey,
  dayLabel,
  formatAgo,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatTime,
  slaSummary,
  toDate,
  checkFiles,
  ACCEPTED_FILES,
} from "./format";

describe("toDate", () => {
  it("returns null for null, undefined and empty", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("")).toBeNull();
  });

  it("treats a zone-less timestamp as UTC", () => {
    const date = toDate("2026-09-12T10:24:00");
    expect(date?.toISOString()).toBe("2026-09-12T10:24:00.000Z");
  });

  it("respects an explicit Z or offset", () => {
    expect(toDate("2026-09-12T10:24:00Z")?.toISOString()).toBe("2026-09-12T10:24:00.000Z");
    expect(toDate("2026-09-12T10:24:00+05:30")?.toISOString()).toBe("2026-09-12T04:54:00.000Z");
  });

  it("returns null for an unparsable string", () => {
    expect(toDate("not-a-date")).toBeNull();
  });
});

describe("formatTime / formatDateTime", () => {
  it("formats a time in the store's clock (IST)", () => {
    expect(formatTime("2026-09-12T04:54:00Z")).toBe("10:24 am");
  });

  it("is empty for a null input", () => {
    expect(formatTime(null)).toBe("");
    expect(formatDateTime(null)).toBe("");
  });

  it("formats the full date and time", () => {
    expect(formatDateTime("2026-09-12T04:54:00Z")).toBe("12 Sept 2026, 10:24 am");
  });
});

describe("dayKey / dayLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is 'Today' for the current calendar day in store time", () => {
    expect(dayLabel("2026-09-12T04:54:00Z")).toBe("Today");
  });

  it("is 'Yesterday' for the previous calendar day", () => {
    expect(dayLabel("2026-09-11T04:54:00Z")).toBe("Yesterday");
  });

  it("is a formatted date for anything older", () => {
    expect(dayLabel("2026-09-01T04:54:00Z")).toBe("1 Sept 2026");
  });

  it("is empty for a null input", () => {
    expect(dayLabel(null)).toBe("");
  });

  it("dayKey is a stable calendar-day string", () => {
    expect(dayKey("2026-09-12T04:54:00Z")).toBe("2026-09-12");
    expect(dayKey(null)).toBe("");
  });
});

describe("formatAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["2026-09-12T11:59:55Z", "just now"],
    ["2026-09-12T11:55:00Z", "5 min ago"],
    ["2026-09-12T09:00:00Z", "3 h ago"],
    ["2026-09-09T12:00:00Z", "3 d ago"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatAgo(input)).toBe(expected);
  });

  it("falls back to the date for anything 7+ days old", () => {
    expect(formatAgo("2026-08-01T12:00:00Z")).toBe("1 Aug 2026");
  });

  it("is empty for a null input", () => {
    expect(formatAgo(null)).toBe("");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0m"],
    [45, "45m"],
    [84, "1h 24m"],
    [-84, "1h 24m"], // absolute value
    [47 * 60, "47h 0m"],
    [48 * 60, "2d 0h"],
    [2900, "2d 0h"],
  ])("%s minutes is %s", (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });
});

describe("slaSummary", () => {
  it.each([
    [{ state: "breached", minutesLeft: 180, dueAt: null } as SlaState, "Breached 3h 0m ago", "critical"],
    [{ state: "breached", minutesLeft: null, dueAt: null } as SlaState, "SLA breached", "critical"],
    [{ state: "due-soon", minutesLeft: 30, dueAt: null } as SlaState, "Due soon · 30m left", "warning"],
    [{ state: "due-soon", minutesLeft: null, dueAt: null } as SlaState, "Due soon · 0m left", "warning"],
    [{ state: "on-track", minutesLeft: 120, dueAt: null } as SlaState, "2h 0m left", "good"],
    [{ state: "paused", minutesLeft: null, dueAt: null } as SlaState, "Paused — waiting on customer", "info"],
    [{ state: "met", minutesLeft: null, dueAt: null } as SlaState, "Met", "good"],
    [{ state: "none", minutesLeft: null, dueAt: null } as SlaState, "No target", "neutral"],
    [{ state: "unknown-state", minutesLeft: null, dueAt: null } as SlaState, "No target", "neutral"],
  ])("summarises %j", (sla, text, tone) => {
    expect(slaSummary(sla)).toEqual({ text, tone });
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1 KB"],
    [2500, "2 KB"],
    [1024 * 1024, "1.0 MB"],
    [1024 * 1024 * 2.5, "2.5 MB"],
  ])("%s bytes is %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("checkFiles", () => {
  const limits = { maxFiles: 2, maxSizeMb: 1, maxVideoSizeMb: 5 };

  function file(name: string, type: string, sizeBytes: number): File {
    return new File([new Uint8Array(sizeBytes)], name, { type });
  }

  it("rejects when there are too many files", () => {
    const files = [file("a.png", "image/png", 10), file("b.png", "image/png", 10), file("c.png", "image/png", 10)];
    expect(checkFiles(files, limits)).toBe("Attach up to 2 files.");
  });

  it("rejects an unaccepted file type", () => {
    const files = [file("a.exe", "application/x-msdownload", 10)];
    expect(checkFiles(files, limits)).toBe("a.exe isn't a type we accept. Use an image, PDF, text file or short video.");
  });

  it("accepts a .csv/.log/.txt file by name even without a matching MIME type", () => {
    const files = [file("notes.txt", "", 10)];
    expect(checkFiles(files, limits)).toBeNull();
  });

  it("rejects a file over the size limit", () => {
    const files = [file("big.png", "image/png", 2 * 1024 * 1024)];
    expect(checkFiles(files, limits)).toBe("big.png is larger than 1 MB.");
  });

  it("allows videos up to the larger video size limit", () => {
    const files = [file("clip.mp4", "video/mp4", 4 * 1024 * 1024)];
    expect(checkFiles(files, limits)).toBeNull();
  });

  it("rejects a video over the video size limit", () => {
    const files = [file("clip.mp4", "video/mp4", 6 * 1024 * 1024)];
    expect(checkFiles(files, limits)).toBe("clip.mp4 is larger than 5 MB.");
  });

  it("is null for an empty file list", () => {
    expect(checkFiles([], limits)).toBeNull();
  });

  it("accepts every type listed in ACCEPTED_FILES", () => {
    const types = ACCEPTED_FILES.split(",").filter((t) => !t.startsWith("."));
    for (const type of types) {
      expect(checkFiles([file("x", type, 10)], limits)).toBeNull();
    }
  });
});
