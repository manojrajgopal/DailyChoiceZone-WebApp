import Link from "next/link";
import { forwardRef } from "react";

import { cn } from "@/lib/utils/cn";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "sale";
type Size = "sm" | "md" | "lg";

/**
 * The button.
 *
 * `primary` is the near-black of the logo's "Daily" rather than the copper —
 * copper reads as decorative at button scale, while the ink reads as an
 * action. Copper is kept for links, focus rings and accents, which is how the
 * logo itself uses it.
 */
const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-ink text-cream hover:bg-ink-700 active:bg-ink disabled:bg-ink-300 disabled:text-cream",
  secondary:
    "bg-copper-500 text-white hover:bg-copper-600 active:bg-copper-700 disabled:bg-copper-200",
  outline:
    "border border-ink bg-transparent text-ink hover:bg-ink hover:text-cream disabled:border-ink-200 disabled:text-ink-300 disabled:hover:bg-transparent",
  ghost:
    "bg-transparent text-ink hover:bg-cream-deep disabled:text-ink-300 disabled:hover:bg-transparent",
  sale: "bg-clay-500 text-white hover:bg-clay-600 disabled:bg-clay-400/40",
};

const SIZES: Record<Size, string> = {
  sm: "h-9 px-4 text-[0.6875rem] tracking-[0.14em]",
  md: "h-11 px-6 text-[0.75rem] tracking-[0.14em]",
  lg: "h-14 px-8 text-[0.8125rem] tracking-[0.14em]",
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-control font-medium uppercase " +
  "transition-colors duration-200 ease-brand disabled:cursor-not-allowed " +
  "whitespace-nowrap select-none";

interface CommonProps {
  variant?: Variant;
  size?: Size;
  /** Stretch to the container's width — used in drawers and mobile bars. */
  fullWidth?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export interface ButtonProps
  extends CommonProps,
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", fullWidth, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
      {...rest}
    >
      {children}
    </button>
  );
});

export interface ButtonLinkProps
  extends CommonProps,
    Omit<React.ComponentPropsWithoutRef<typeof Link>, "className" | "children"> {}

/**
 * A link that looks like a button.
 *
 * Separate from `Button` on purpose: navigation belongs in an anchor so it
 * keeps middle-click, "open in new tab" and the browser's own affordances.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = "primary", size = "md", fullWidth, className, children, ...rest },
  ref,
) {
  return (
    <Link
      ref={ref}
      className={cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && "w-full", className)}
      {...rest}
    >
      {children}
    </Link>
  );
});
