import { Headset, RefreshCw, ShieldCheck, Truck } from "lucide-react";

import type { TrustIcon, TrustPoint } from "@/types";

const ICONS: Record<TrustIcon, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  truck: Truck,
  shield: ShieldCheck,
  refresh: RefreshCw,
  headset: Headset,
};

/**
 * The reassurance strip: delivery, quality, returns and support.
 *
 * The icon tints reuse the logo's own trust badges — blush, sage and peach —
 * which is what ties this block visually back to the mark.
 */
const TINTS = ["bg-blush-100", "bg-sage-100", "bg-peach-100", "bg-copper-100"] as const;

export function TrustStrip({ points }: { points: TrustPoint[] }) {
  if (points.length === 0) return null;

  return (
    <ul className="grid grid-cols-1 gap-x-8 gap-y-7 border-y border-ink-200 py-10 sm:grid-cols-2 lg:grid-cols-4">
      {points.map((point, index) => {
        const Icon = ICONS[point.icon];
        return (
          <li key={point.title} className="flex items-start gap-3.5">
            <span
              className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-pill ${TINTS[index % TINTS.length]}`}
            >
              <Icon className="h-[1.125rem] w-[1.125rem] text-ink-700" strokeWidth={1.5} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-ink">{point.title}</span>
              <span className="mt-1 block text-xs leading-relaxed text-ink-500">{point.text}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
