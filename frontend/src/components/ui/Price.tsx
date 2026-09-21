import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";

type Size = "sm" | "md" | "lg";

const CURRENT: Record<Size, string> = {
  sm: "text-[0.8125rem]",
  md: "text-[0.9375rem]",
  lg: "text-xl",
};

const STRUCK: Record<Size, string> = {
  sm: "text-[0.75rem]",
  md: "text-[0.8125rem]",
  lg: "text-sm",
};

export interface PriceProps {
  price: number;
  /** Shown struck through only when it is genuinely higher than `price`. */
  originalPrice?: number;
  discount?: number;
  size?: Size;
  /** Hide the "28% off" text where space is tight. */
  showDiscount?: boolean;
  className?: string;
}

/**
 * A price, with its original price and reduction.
 *
 * The one component that renders money anywhere in the app, so formatting and
 * the rule for when a strike-through is honest live in a single place.
 */
export function Price({
  price,
  originalPrice,
  discount,
  size = "md",
  showDiscount = true,
  className,
}: PriceProps) {
  const isReduced = typeof originalPrice === "number" && originalPrice > price;
  const percent = discount ?? 0;

  return (
    <span className={cn("inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5", className)}>
      <span className={cn("font-medium text-ink tabular-nums", CURRENT[size])}>
        {formatPrice(price)}
      </span>

      {isReduced ? (
        <span className={cn("text-ink-400 line-through tabular-nums", STRUCK[size])}>
          {formatPrice(originalPrice)}
        </span>
      ) : null}

      {isReduced && showDiscount && percent > 0 ? (
        <span className={cn("font-medium text-clay-500 tabular-nums", STRUCK[size])}>
          {percent}% off
        </span>
      ) : null}
    </span>
  );
}
