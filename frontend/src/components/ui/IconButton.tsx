import { forwardRef } from "react";

import { cn } from "@/lib/utils/cn";

type Variant = "plain" | "filled" | "surface";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  plain: "text-ink hover:bg-cream-deep",
  filled: "bg-ink text-cream hover:bg-ink-700",
  // For icons floating over product photography — needs its own backdrop.
  surface: "bg-shell/90 text-ink shadow-subtle backdrop-blur-sm hover:bg-shell",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 w-8",
  md: "h-10 w-10",
};

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  /**
   * Required. An icon alone tells a screen reader nothing, so this becomes the
   * accessible name and the tooltip.
   */
  label: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: React.ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = "plain", size = "md", className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-pill transition-colors duration-200 ease-brand",
        "disabled:cursor-not-allowed disabled:opacity-40",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
