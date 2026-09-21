import { Star } from "lucide-react";

import { cn } from "@/lib/utils/cn";
import { formatCount } from "@/lib/utils/format";

export interface RatingProps {
  /** 0–5. Halves are rendered as a partially filled star. */
  value: number;
  reviewCount?: number;
  size?: "sm" | "md";
  /** Show "4.5" next to the stars. */
  showValue?: boolean;
  className?: string;
}

/**
 * A star rating.
 *
 * The stars are decorative — the accessible name carries the actual value, so
 * a screen reader hears "Rated 4.5 out of 5 from 128 reviews" rather than
 * five identical star labels.
 */
export function Rating({
  value,
  reviewCount,
  size = "sm",
  showValue = true,
  className,
}: RatingProps) {
  const clamped = Math.max(0, Math.min(5, value));
  const starSize = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  const label = reviewCount
    ? `Rated ${clamped} out of 5 from ${reviewCount} reviews`
    : `Rated ${clamped} out of 5`;

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} aria-label={label}>
      <span className="inline-flex" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => {
          // How much of this particular star should be filled.
          const fill = Math.max(0, Math.min(1, clamped - index));
          return (
            <span key={index} className="relative inline-block">
              <Star className={cn(starSize, "text-ink-200")} strokeWidth={1.5} />
              {fill > 0 ? (
                <span
                  className="absolute inset-0 overflow-hidden"
                  style={{ width: `${fill * 100}%` }}
                >
                  <Star
                    className={cn(starSize, "fill-copper-500 text-copper-500")}
                    strokeWidth={1.5}
                  />
                </span>
              ) : null}
            </span>
          );
        })}
      </span>

      {showValue ? (
        <span className="text-[0.75rem] font-medium text-ink-700 tabular-nums" aria-hidden="true">
          {clamped.toFixed(1)}
        </span>
      ) : null}

      {typeof reviewCount === "number" ? (
        <span className="text-[0.75rem] text-ink-400 tabular-nums" aria-hidden="true">
          ({formatCount(reviewCount)})
        </span>
      ) : null}
    </span>
  );
}
