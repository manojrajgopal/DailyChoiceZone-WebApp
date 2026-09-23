/**
 * CSV export.
 *
 * Kept away from the components that trigger it, because export is a data
 * concern: when a backend can produce these server-side (with the whole result
 * set, not just the page on screen), the button stays and this file is replaced
 * by a download link.
 *
 * Two details that matter more than they look:
 *
 * - **Escaping.** A product called `Shirt, Blue "Slim"` breaks a naive join.
 *   Anything containing a comma, quote or newline is quoted, and inner quotes
 *   are doubled — the actual RFC 4180 rule, not an approximation.
 * - **Formula injection.** A cell starting `=`, `+`, `-` or `@` is executed by
 *   Excel and Sheets when the file is opened. Since these files carry names and
 *   addresses that people type, every such cell is prefixed with a tab so it is
 *   read as text. A CSV export is a real attack surface, and this is the fix.
 */

function escapeCell(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);

  // Neutralise anything a spreadsheet would treat as a formula.
  const safe = /^[=+\-@\t\r]/.test(raw) ? `\t${raw}` : raw;

  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((column) => escapeCell(column.header)).join(",");
  const body = rows.map((row) =>
    columns.map((column) => escapeCell(column.value(row))).join(","),
  );
  return [head, ...body].join("\r\n");
}

/**
 * Hand the file to the browser.
 *
 * A BOM is prepended because Excel on Windows otherwise reads UTF-8 as the
 * system codepage and renders ₹ as mojibake — which, for a file of rupee
 * amounts, makes the export useless to the person who asked for it.
 */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof window === "undefined") return;

  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** `invoices-2026-09-23.csv` — dated, so repeated exports do not overwrite. */
export function datedFilename(stem: string, date: Date = new Date()): string {
  return `${stem}-${date.toISOString().slice(0, 10)}.csv`;
}
