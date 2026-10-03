"use client";

import { useEffect, useRef, useState } from "react";
import { Ruler } from "lucide-react";

import type { MeasurementCell, SizeGuide, SizeUnit } from "@/services/discoveryService";

import { Modal } from "@/components/ui/Dialog";
import { cn } from "@/lib/utils/cn";
import { UNIT_LABELS, convertCell, formatCell } from "@/lib/discovery/units";

const UNIT_KEY = "dcz:size-unit";

function rememberedUnit(units: SizeUnit[], fallback: SizeUnit): SizeUnit {
  try {
    const stored = window.localStorage.getItem(UNIT_KEY) as SizeUnit | null;
    return stored && units.includes(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function sameSize(a: string | null | undefined, b: string): boolean {
  return (a ?? "").replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
}

/**
 * "Size guide" on the product page: a button that opens the product's own
 * size table — the one assigned to it, its category's, or the store default.
 *
 * The table is a real `<table>` with a caption and header cells, so a screen
 * reader announces "Chest, M, 92–97 cm". Measurements switch between cm and
 * inches, converted from the stored values; the choice is remembered on this
 * device. Each size the product is sold in can be chosen straight from its row.
 */
export function SizeGuideButton({
  guide,
  selectedSize,
  onSelectSize,
}: {
  guide: SizeGuide;
  selectedSize?: string | null;
  onSelectSize?: (size: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  // Back to the button that opened it once it closes — Radix does this only
  // for its own trigger, and this one is a plain button.
  useEffect(() => {
    if (wasOpen.current && !open) {
      const timer = setTimeout(() => button.current?.focus(), 0);
      wasOpen.current = false;
      return () => clearTimeout(timer);
    }
    wasOpen.current = open;
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-copper-700 underline underline-offset-2 transition-colors hover:text-ink"
        aria-haspopup="dialog"
      >
        <Ruler className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
        Size guide
      </button>
      <SizeGuideDialog
        guide={guide}
        open={open}
        onOpenChange={setOpen}
        selectedSize={selectedSize}
        onSelectSize={onSelectSize ? (size) => {
          onSelectSize(size);
          setOpen(false);
        } : undefined}
      />
    </>
  );
}

export function SizeGuideDialog({
  guide,
  open,
  onOpenChange,
  selectedSize,
  onSelectSize,
}: {
  guide: SizeGuide;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedSize?: string | null;
  onSelectSize?: (size: string) => void;
}) {
  const units = guide.units.length ? guide.units : [guide.storedUnit];
  const [unit, setUnitState] = useState<SizeUnit | null>(null);
  const shown = unit ?? (open ? rememberedUnit(units, guide.storedUnit) : guide.storedUnit);
  const setUnit = (next: SizeUnit) => {
    setUnitState(next);
    try {
      window.localStorage.setItem(UNIT_KEY, next);
    } catch {
      /* a convenience only */
    }
  };
  const hasMeasurements = guide.columns.some((column) => column.type === "measurement");

  const cell = (row: SizeGuide["rows"][number], key: string, type: string) => {
    const stored = row.stored?.[key];
    if (type === "measurement" && stored) return formatCell(convertCell(stored, guide.storedUnit, shown), shown);
    const value = row.values[key];
    if (value === undefined || value === null || value === "") return "—";
    if (typeof value === "object") return formatCell(value as MeasurementCell, guide.unit);
    return String(value);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={guide.name}
      description={guide.description || undefined}
      className="max-w-2xl"
    >
      {hasMeasurements && units.length > 1 ? (
        <div className="mb-4 flex items-center gap-3">
          <span id="size-unit-label" className="label-wide text-ink-500">Units</span>
          <div role="group" aria-labelledby="size-unit-label" className="inline-flex rounded-pill border border-ink-200 p-0.5">
            {units.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setUnit(option)}
                aria-pressed={shown === option}
                aria-label={UNIT_LABELS[option]}
                className={cn(
                  "rounded-pill px-3.5 py-1 text-xs font-medium transition-colors",
                  shown === option ? "bg-ink text-cream" : "text-ink-600 hover:text-ink",
                )}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="scroll-panel -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[22rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            {guide.name}
            {hasMeasurements ? `, measurements in ${UNIT_LABELS[shown].toLowerCase()}` : ""}
          </caption>
          <thead>
            <tr className="border-b border-ink-200">
              <th scope="col" className="py-2.5 pr-4 label-wide text-ink-500">Size</th>
              {guide.columns.map((column) => (
                <th key={column.key} scope="col" className="py-2.5 pr-4 label-wide text-ink-500">
                  {column.label}
                </th>
              ))}
              {onSelectSize ? <th scope="col" className="py-2.5"><span className="sr-only">Choose</span></th> : null}
            </tr>
          </thead>
          <tbody>
            {guide.rows.map((row) => {
              const chosen = sameSize(selectedSize, row.size);
              return (
                <tr
                  key={row.size}
                  className={cn(
                    "border-b border-ink-100",
                    chosen && "bg-cream-deep",
                    !row.offered && "text-ink-400",
                  )}
                >
                  <th scope="row" className="py-2.5 pr-4 font-medium text-ink">
                    {row.size}
                    {chosen ? <span className="ml-2 text-xs font-normal text-copper-700">Selected</span> : null}
                    {!row.offered ? <span className="ml-2 text-xs font-normal">(not available)</span> : null}
                  </th>
                  {guide.columns.map((column) => (
                    <td key={column.key} className="py-2.5 pr-4 tabular-nums">{cell(row, column.key, column.type)}</td>
                  ))}
                  {onSelectSize ? (
                    <td className="py-2 text-right">
                      {row.offered ? (
                        <button
                          type="button"
                          onClick={() => onSelectSize(row.size)}
                          aria-label={`Choose size ${row.size}`}
                          aria-pressed={chosen}
                          className="rounded-control border border-ink-200 px-2.5 py-1 text-xs text-ink transition-colors hover:border-ink"
                        >
                          {chosen ? "Chosen" : "Choose"}
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {guide.instructions.length > 0 ? (
        <section aria-labelledby="how-to-measure" className="mt-6">
          <h3 id="how-to-measure" className="font-display text-base text-ink">How to measure</h3>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {guide.instructions.map((step) => (
              <div key={step.title} className="rounded-card bg-cream-deep p-3">
                <dt className="text-sm font-medium text-ink">{step.title}</dt>
                <dd className="mt-1 text-xs leading-relaxed text-ink-600">{step.body}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {guide.notes ? <p className="mt-5 text-xs leading-relaxed text-ink-500">{guide.notes}</p> : null}
    </Modal>
  );
}
