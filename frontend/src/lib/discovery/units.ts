import type { MeasurementCell, SizeUnit } from "@/services/discoveryService";

/**
 * Size-guide units, converted the way the server does it.
 *
 * Always from the value as stored, never from a value already rounded for
 * display — so switching cm → in → cm shows 92 cm again, not 91.9. The factors
 * are exact (1 in = 25.4 mm by definition) and the result is rounded once, at
 * the end: to a whole millimetre, otherwise to one decimal place.
 */
const MM: Record<SizeUnit, number> = { mm: 1, cm: 10, in: 25.4 };

export function convert(value: number, from: SizeUnit, to: SizeUnit): number {
  if (from === to) return value;
  return (value * MM[from]) / MM[to];
}

export function round(value: number, unit: SizeUnit): number {
  const step = unit === "mm" ? 1 : 10;
  // `toFixed` first squeezes out binary noise (36.25 stored as 36.2499…), so
  // halves round up the way the server's ROUND_HALF_UP does.
  return Math.round(Number((value * step).toFixed(6))) / step;
}

export function convertCell(cell: MeasurementCell, from: SizeUnit, to: SizeUnit): MeasurementCell {
  const out: MeasurementCell = { min: round(convert(cell.min, from, to), to) };
  if (cell.max !== undefined) out.max = round(convert(cell.max, from, to), to);
  return out;
}

const SYMBOL: Record<SizeUnit, string> = { cm: "cm", in: "in", mm: "mm" };

/** "92–97 cm", "36.2 in". */
export function formatCell(cell: MeasurementCell, unit: SizeUnit): string {
  const value = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: unit === "mm" ? 0 : 1 });
  const text = cell.max !== undefined && cell.max !== cell.min ? `${value(cell.min)}–${value(cell.max)}` : value(cell.min);
  return `${text} ${SYMBOL[unit]}`;
}

export const UNIT_LABELS: Record<SizeUnit, string> = { cm: "Centimetres", in: "Inches", mm: "Millimetres" };
