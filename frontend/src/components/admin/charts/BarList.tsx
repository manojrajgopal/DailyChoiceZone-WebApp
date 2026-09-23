"use client";

import { cn } from "@/lib/utils/cn";

export interface BarDatum {
  /** Stable key and axis label. */
  label: string;
  value: number;
  /** Optional secondary figure, shown in muted ink beside the value. */
  meta?: string;
  href?: string;
}

/**
 * A horizontal bar list.
 *
 * Horizontal rather than vertical because the categories are words, and
 * vertical bars force those words to rotate or truncate.
 *
 * Two colouring modes, and the distinction matters:
 *
 * - **nominal** — the categories have no inherent order (departments, brands).
 *   Every bar takes the same hue. Colouring them differently would spend the
 *   identity channel re-encoding what bar length already shows.
 * - **ordinal** — the categories *are* a sequence (an order funnel), so a
 *   single-hue light-to-dark ramp puts that order into the colour.
 *
 * Every bar is directly labelled with its value, which is also what discharges
 * the palette's contrast warning: the number never depends on reading the hue.
 */
export function BarList({
  data,
  scale = "nominal",
  valueFormat = (value) => value.toLocaleString("en-IN"),
  emptyMessage = "No data for this period.",
  className,
}: {
  data: BarDatum[];
  scale?: "nominal" | "ordinal";
  valueFormat?: (value: number) => string;
  emptyMessage?: string;
  className?: string;
}) {
  if (data.length === 0) {
    return <p className={cn("py-6 text-center text-xs text-admin-muted", className)}>{emptyMessage}</p>;
  }

  const max = Math.max(...data.map((datum) => datum.value), 1);

  // The ordinal ramp, light to dark. Sampled evenly so a short list still
  // spans the full range rather than crowding into the light end.
  const RAMP = [
    "var(--color-seq-200)",
    "var(--color-seq-300)",
    "var(--color-seq-400)",
    "var(--color-seq-500)",
    "var(--color-seq-600)",
    "var(--color-seq-700)",
  ];

  const colourFor = (index: number) => {
    if (scale === "nominal") return "var(--color-chart-1)";
    const step = data.length <= 1 ? 0 : Math.round((index / (data.length - 1)) * (RAMP.length - 1));
    return RAMP[step];
  };

  return (
    <ul className={cn("flex flex-col gap-2.5", className)}>
      {data.map((datum, index) => {
        const percent = (datum.value / max) * 100;

        return (
          <li key={datum.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-xs text-admin-ink">{datum.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-admin-ink">
                {valueFormat(datum.value)}
                {datum.meta ? (
                  <span className="ml-1.5 text-admin-faint">{datum.meta}</span>
                ) : null}
              </span>
            </div>

            {/* The track gives the bar a baseline to be measured against;
                the 4px rounded end is anchored to it, never floating. */}
            <span className="block h-2 w-full overflow-hidden rounded-[2px] bg-admin-raised">
              <span
                className="block h-full rounded-[2px] transition-[width] duration-300"
                style={{ width: `${Math.max(percent, 1.5)}%`, backgroundColor: colourFor(index) }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
