import { cn } from "@/lib/utils/cn";

type Tone = "new" | "bestseller" | "sale" | "neutral" | "stock" | "soldout";

/**
 * Product and status badges.
 *
 * Each tone maps to a colour the logo already uses, so badges never introduce
 * a new hue: sage for availability, clay for reductions, ink for authority,
 * blush for the softer merchandising flags.
 */
const TONES: Record<Tone, string> = {
  new: "bg-ink text-cream",
  bestseller: "bg-blush-200 text-copper-800",
  sale: "bg-clay-500 text-white",
  neutral: "bg-cream-deep text-ink-700",
  stock: "bg-sage-100 text-sage-600",
  soldout: "bg-ink-200 text-ink-700",
};

export interface BadgeProps {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}

export function Badge({ tone = "neutral", className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-control px-2 py-1 label-wide",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
