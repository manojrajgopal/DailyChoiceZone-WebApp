"use client";

import { Minus, Plus } from "lucide-react";

import type { ProductColor } from "@/types";

import { cn } from "@/lib/utils/cn";

/**
 * Variant and quantity controls, shared by the product page and quick view.
 *
 * All three are radio-group or spinbutton patterns rather than styled divs, so
 * they are reachable and operable from a keyboard and announce their state.
 */

/* ----------------------------------------------------------------- SizePicker */

export interface SizePickerProps {
  sizes: string[];
  value: string | null;
  onChange: (size: string) => void;
  /** Marks the group invalid after a failed "add to bag" with no size chosen. */
  error?: boolean;
  className?: string;
}

export function SizePicker({ sizes, value, onChange, error, className }: SizePickerProps) {
  if (sizes.length === 0) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Select size"
      aria-invalid={error || undefined}
      className={cn("flex flex-wrap gap-2", className)}
    >
      {sizes.map((size) => {
        const selected = size === value;
        return (
          <button
            key={size}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(size)}
            className={cn(
              "inline-flex h-10 min-w-[2.75rem] items-center justify-center rounded-control border px-3 text-sm transition-colors",
              selected
                ? "border-ink bg-ink text-cream"
                : "border-ink-200 bg-shell text-ink hover:border-ink",
              error && !value && "border-danger",
            )}
          >
            {size}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- ColorPicker */

export interface ColorPickerProps {
  colors: ProductColor[];
  value: string | null;
  onChange: (colorName: string) => void;
  className?: string;
}

export function ColorPicker({ colors, value, onChange, className }: ColorPickerProps) {
  if (colors.length === 0) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Select colour"
      className={cn("flex flex-wrap gap-2.5", className)}
    >
      {colors.map((color) => {
        const selected = color.name === value;
        return (
          <button
            key={color.name}
            type="button"
            role="radio"
            aria-checked={selected}
            // The swatch is colour alone, so the name must be in the a11y name.
            aria-label={color.name}
            title={color.name}
            onClick={() => onChange(color.name)}
            className={cn(
              "relative inline-flex h-9 w-9 items-center justify-center rounded-pill transition-transform",
              // A ring rather than a border, so the swatch colour stays true.
              selected
                ? "ring-2 ring-ink ring-offset-2 ring-offset-cream"
                : "ring-1 ring-ink-200 hover:ring-ink-400",
            )}
          >
            <span
              className="h-7 w-7 rounded-pill"
              style={{ backgroundColor: color.hex }}
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ QuantityStepper */

export interface QuantityStepperProps {
  value: number;
  onChange: (quantity: number) => void;
  min?: number;
  max?: number;
  size?: "sm" | "md";
  className?: string;
}

export function QuantityStepper({
  value,
  onChange,
  min = 1,
  max = 99,
  size = "md",
  className,
}: QuantityStepperProps) {
  const dimension = size === "sm" ? "h-8 w-8" : "h-10 w-10";

  return (
    <div
      className={cn("inline-flex items-center rounded-control border border-ink-200", className)}
    >
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        aria-label="Decrease quantity"
        className={cn(
          "inline-flex items-center justify-center text-ink transition-colors hover:bg-cream-deep",
          "disabled:cursor-not-allowed disabled:text-ink-300 disabled:hover:bg-transparent",
          dimension,
        )}
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={2} />
      </button>

      <span
        role="spinbutton"
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label="Quantity"
        tabIndex={0}
        className={cn(
          "min-w-9 select-none text-center text-sm font-medium text-ink tabular-nums",
          size === "sm" && "min-w-7 text-xs",
        )}
      >
        {value}
      </span>

      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label="Increase quantity"
        className={cn(
          "inline-flex items-center justify-center text-ink transition-colors hover:bg-cream-deep",
          "disabled:cursor-not-allowed disabled:text-ink-300 disabled:hover:bg-transparent",
          dimension,
        )}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
