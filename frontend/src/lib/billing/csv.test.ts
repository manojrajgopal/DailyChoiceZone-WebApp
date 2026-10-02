import { afterEach, describe, expect, it, vi } from "vitest";

import { datedFilename, downloadCsv, escapeCell, toCsv, type CsvColumn } from "./csv";

describe("escapeCell", () => {
  it.each([
    [null, ""],
    [undefined, ""],
    [42, "42"],
    ["plain", "plain"],
    ["has,comma", '"has,comma"'],
    ['has"quote', '"has""quote"'],
    ["has\nnewline", '"has\nnewline"'],
    ["=SUM(A1)", "\t=SUM(A1)"],
    ["+1", "\t+1"],
    ["-5", "\t-5"],
    ["@mention", "\t@mention"],
    ["normal-5", "normal-5"],
  ])("escapes %j as %j", (value, expected) => {
    expect(escapeCell(value)).toBe(expected);
  });

  it("quotes a formula-looking value that also needs quoting", () => {
    expect(escapeCell("=A1,B1")).toBe('"\t=A1,B1"');
  });
});

describe("toCsv", () => {
  interface Row {
    name: string;
    amount: number;
  }
  const columns: CsvColumn<Row>[] = [
    { header: "Name", value: (r) => r.name },
    { header: "Amount", value: (r) => r.amount },
  ];

  it("builds a header row plus one row per item, CRLF-joined", () => {
    const csv = toCsv<Row>([{ name: "A", amount: 1 }, { name: "B, Inc", amount: 2 }], columns);
    expect(csv).toBe('Name,Amount\r\nA,1\r\n"B, Inc",2');
  });

  it("is just the header for an empty row set", () => {
    expect(toCsv<Row>([], columns)).toBe("Name,Amount");
  });
});

describe("datedFilename", () => {
  it("appends the ISO date", () => {
    expect(datedFilename("invoices", new Date("2026-09-23T10:00:00Z"))).toBe("invoices-2026-09-23.csv");
  });

  it("defaults to the current date", () => {
    const filename = datedFilename("orders");
    expect(filename).toMatch(/^orders-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});

describe("downloadCsv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("creates and clicks a download link with a BOM-prefixed blob, then revokes the URL", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:csv");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    let downloadName = "";
    click.mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });

    downloadCsv("report", "a,b\n1,2");

    expect(createObjectURL).toHaveBeenCalled();
    expect(downloadName).toBe("report.csv");
    expect(document.querySelector("a[download]")).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:csv");
  });

  it("does not append .csv twice", () => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:csv");
    let downloadName = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });
    downloadCsv("report.csv", "a,b");
    expect(downloadName).toBe("report.csv");
  });

  it("does nothing server-side (no window)", () => {
    const original = globalThis.window;
    // @ts-expect-error -- simulating SSR
    delete globalThis.window;
    try {
      expect(() => downloadCsv("x", "a,b")).not.toThrow();
    } finally {
      globalThis.window = original;
    }
  });
});
