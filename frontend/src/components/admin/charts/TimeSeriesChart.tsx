"use client";

import { useMemo, useState } from "react";

import type { TimeSeriesPoint } from "@/types/admin";

import { cn } from "@/lib/utils/cn";
import {
  formatCompactINR,
  formatCompactNumber,
  formatPrice,
  formatSeriesLabel,
} from "@/lib/utils/format";

import { useElementWidth } from "./useElementWidth";

/**
 * A single-series line chart over time.
 *
 * Deliberately one measure per chart. Revenue and order count live on
 * different scales, and plotting both against two y-axes is the single most
 * misleading thing a dashboard can do — the crossover point is an artefact of
 * the axis choice, not the data. Two charts side by side answer the same
 * question honestly.
 *
 * One series means no legend: the card title names what is plotted.
 */
export function TimeSeriesChart({
  points,
  metric,
  height = 220,
  className,
}: {
  points: TimeSeriesPoint[];
  metric: "revenue" | "orders";
  height?: number;
  className?: string;
}) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const isCurrency = metric === "revenue";
  const compact = isCurrency ? formatCompactINR : formatCompactNumber;
  const exact = isCurrency ? formatPrice : (value: number) => value.toLocaleString("en-IN");

  // Space for axis labels. Left is wider because "₹2.85L" needs room.
  const PAD = { top: 12, right: 12, bottom: 26, left: 46 };

  const plot = useMemo(() => {
    const innerWidth = Math.max(0, width - PAD.left - PAD.right);
    const innerHeight = height - PAD.top - PAD.bottom;
    const values = points.map((point) => point[metric]);

    // Always include zero: a line chart that starts the axis at the minimum
    // exaggerates every wobble into a cliff.
    const max = Math.max(...values, 1);
    const niceMax = niceCeiling(max);

    const x = (index: number) =>
      points.length <= 1
        ? PAD.left + innerWidth / 2
        : PAD.left + (index / (points.length - 1)) * innerWidth;

    const y = (value: number) => PAD.top + innerHeight - (value / niceMax) * innerHeight;

    const line = points
      .map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(point[metric])}`)
      .join(" ");

    const area =
      points.length > 0
        ? `${line} L${x(points.length - 1)},${PAD.top + innerHeight} L${x(0)},${PAD.top + innerHeight} Z`
        : "";

    return { innerWidth, innerHeight, niceMax, x, y, line, area };
  }, [points, metric, width, height, PAD.left, PAD.right, PAD.top, PAD.bottom]);

  const ticks = useMemo(
    () => [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * plot.niceMax),
    [plot.niceMax],
  );

  /** Label every nth point, so they never collide. */
  const labelEvery = Math.max(1, Math.ceil(points.length / (width < 520 ? 4 : 7)));

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (points.length === 0 || plot.innerWidth <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - bounds.left - PAD.left;
    const ratio = Math.max(0, Math.min(1, offset / plot.innerWidth));
    setHoverIndex(Math.round(ratio * (points.length - 1)));
  };

  return (
    <div ref={containerRef} className={cn("relative w-full", className)}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${isCurrency ? "Revenue" : "Orders"} over time. ${points.length} points, peak ${exact(Math.max(...points.map((p) => p[metric]), 0))}.`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverIndex(null)}
          className="touch-none"
        >
          {/* Gridlines and their labels: recessive, so the line reads first. */}
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={plot.y(tick)}
                y2={plot.y(tick)}
                stroke="var(--color-chart-grid)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={plot.y(tick)}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={10}
                fill="var(--color-chart-label)"
              >
                {compact(tick)}
              </text>
            </g>
          ))}

          {points.map((point, index) =>
            index % labelEvery === 0 ? (
              <text
                key={point.label}
                x={plot.x(index)}
                y={height - 8}
                textAnchor="middle"
                fontSize={10}
                fill="var(--color-chart-label)"
              >
                {formatSeriesLabel(point.label)}
              </text>
            ) : null,
          )}

          <path d={plot.area} fill="var(--color-chart-1)" opacity={0.08} />
          <path
            d={plot.line}
            fill="none"
            stroke="var(--color-chart-1)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Crosshair and marker. A 2px surface ring keeps the dot legible
              wherever it lands on the line. */}
          {hoverIndex !== null && hovered ? (
            <g pointerEvents="none">
              <line
                x1={plot.x(hoverIndex)}
                x2={plot.x(hoverIndex)}
                y1={PAD.top}
                y2={PAD.top + plot.innerHeight}
                stroke="var(--color-chart-axis)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle
                cx={plot.x(hoverIndex)}
                cy={plot.y(hovered[metric])}
                r={5}
                fill="var(--color-chart-1)"
                stroke="var(--color-admin-surface)"
                strokeWidth={2}
              />
            </g>
          ) : null}
        </svg>
      ) : (
        <div style={{ height }} />
      )}

      {hoverIndex !== null && hovered && width > 0 ? (
        <div
          role="status"
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-[3px] border border-admin-border bg-admin-surface px-2.5 py-1.5 shadow-raised"
          style={{
            // Keep the tooltip inside the card at either edge.
            left: Math.min(Math.max(plot.x(hoverIndex), 60), width - 60),
            top: plot.y(hovered[metric]) - 10,
          }}
        >
          <p className="text-[0.625rem] text-admin-muted">{formatSeriesLabel(hovered.label)}</p>
          <p className="text-xs font-semibold text-admin-ink tabular-nums">
            {exact(hovered[metric])}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Round an axis maximum up to something a person would choose. */
function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}
