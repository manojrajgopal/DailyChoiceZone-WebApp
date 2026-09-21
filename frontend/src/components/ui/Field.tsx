"use client";

import { forwardRef, useId } from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Form controls.
 *
 * Every control here is wired for accessibility by construction rather than by
 * remembering: labels are associated via generated ids, errors are announced
 * through `aria-describedby` plus `role="alert"`, and invalid fields carry
 * `aria-invalid`. Checkboxes and radios use a real input behind a styled box,
 * so keyboard and screen-reader behaviour is the browser's, not ours.
 */

const CONTROL =
  "w-full rounded-control border bg-shell px-3.5 text-[0.9375rem] text-ink " +
  "placeholder:text-ink-400 transition-colors duration-200 " +
  "disabled:cursor-not-allowed disabled:bg-cream-deep disabled:text-ink-400";

const CONTROL_BORDER = "border-ink-200 hover:border-ink-300 focus:border-copper-500";
const CONTROL_ERROR = "border-danger hover:border-danger focus:border-danger";

interface FieldShellProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: (ids: { id: string; describedBy: string | undefined }) => React.ReactNode;
}

/** Shared label / hint / error scaffolding. */
function FieldShell({ label, hint, error, required, className, children }: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label htmlFor={id} className="label-wide text-ink-700">
          {label}
          {required ? (
            <span className="ml-1 text-clay-500" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}

      {children({ id, describedBy: describedBy || undefined })}

      {hint && !error ? (
        <p id={hintId} className="text-xs text-ink-400">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------- Input */

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "className" | "id"> {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
  inputClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, className, inputClassName, required, ...rest },
  ref,
) {
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      {({ id, describedBy }) => (
        <input
          ref={ref}
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(CONTROL, "h-11", error ? CONTROL_ERROR : CONTROL_BORDER, inputClassName)}
          {...rest}
        />
      )}
    </FieldShell>
  );
});

/* ------------------------------------------------------------------- Textarea */

export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "id"> {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, required, rows = 4, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} className={className}>
      {({ id, describedBy }) => (
        <textarea
          ref={ref}
          id={id}
          rows={rows}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(CONTROL, "py-2.5", error ? CONTROL_ERROR : CONTROL_BORDER)}
          {...rest}
        />
      )}
    </FieldShell>
  );
});

/* --------------------------------------------------------------------- Select */

export interface SelectProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "className" | "id" | "children"> {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
  selectClassName?: string;
  options: { value: string; label: string }[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, className, selectClassName, options, required, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} className={className}>
      {({ id, describedBy }) => (
        <div className="relative">
          <select
            ref={ref}
            id={id}
            required={required}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cn(
              CONTROL,
              "h-11 cursor-pointer appearance-none pr-10",
              error ? CONTROL_ERROR : CONTROL_BORDER,
              selectClassName,
            )}
            {...rest}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </div>
      )}
    </FieldShell>
  );
});

/* ------------------------------------------------------------------- Checkbox */

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "className" | "type"> {
  label: React.ReactNode;
  /** Right-aligned count, as in "Sneakers (12)". */
  count?: number;
  className?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, count, className, ...rest },
  ref,
) {
  return (
    <label
      className={cn(
        "group flex cursor-pointer items-center gap-2.5 py-1.5 text-sm text-ink-700",
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:text-ink-300",
        className,
      )}
    >
      <span className="relative inline-flex h-[1.125rem] w-[1.125rem] shrink-0 items-center justify-center">
        <input
          ref={ref}
          type="checkbox"
          className="peer h-full w-full cursor-pointer appearance-none rounded-[2px] border border-ink-300 bg-shell transition-colors checked:border-ink checked:bg-ink disabled:cursor-not-allowed disabled:border-ink-200 disabled:bg-cream-deep"
          {...rest}
        />
        <Check
          className="pointer-events-none absolute h-3 w-3 text-cream opacity-0 transition-opacity peer-checked:opacity-100"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </span>

      <span className="min-w-0 flex-1 truncate">{label}</span>

      {typeof count === "number" ? (
        <span className="shrink-0 text-xs text-ink-400 tabular-nums">{count}</span>
      ) : null}
    </label>
  );
});

/* ---------------------------------------------------------------------- Radio */

export interface RadioProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "className" | "type"> {
  label: React.ReactNode;
  description?: string;
  className?: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { label, description, className, ...rest },
  ref,
) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-card border border-ink-200 bg-shell p-3.5",
        "transition-colors hover:border-ink-300 has-[:checked]:border-ink has-[:checked]:bg-cream-deep",
        className,
      )}
    >
      <span className="relative mt-0.5 inline-flex h-[1.125rem] w-[1.125rem] shrink-0 items-center justify-center">
        <input
          ref={ref}
          type="radio"
          className="peer h-full w-full cursor-pointer appearance-none rounded-pill border border-ink-300 bg-shell transition-colors checked:border-ink"
          {...rest}
        />
        <span className="pointer-events-none absolute h-2 w-2 rounded-pill bg-ink opacity-0 transition-opacity peer-checked:opacity-100" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-ink-500">{description}</span>
        ) : null}
      </span>
    </label>
  );
});
