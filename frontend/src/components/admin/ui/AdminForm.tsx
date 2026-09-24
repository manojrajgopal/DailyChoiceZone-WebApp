"use client";

import { useId, useState } from "react";
import { ImagePlus, Plus, X } from "lucide-react";

import { cn } from "@/lib/utils/cn";

/**
 * Admin form controls.
 *
 * Denser than the storefront's, and wired for accessibility by construction:
 * labels are associated through generated ids, errors are announced via
 * `aria-describedby` plus `role="alert"`, and invalid fields carry
 * `aria-invalid`. A field cannot be rendered without a label.
 */

const CONTROL =
  "w-full rounded-[3px] border bg-admin-surface px-2.5 text-[0.8125rem] text-admin-ink " +
  "placeholder:text-admin-faint transition-colors " +
  "disabled:cursor-not-allowed disabled:bg-admin-raised disabled:text-admin-faint";

const BORDER = "border-admin-border hover:border-admin-border-strong focus:border-copper-500";
const BORDER_ERROR = "border-[#c23434] focus:border-[#c23434]";

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: (ids: { id: string; describedBy?: string }) => React.ReactNode;
}

function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-xs font-medium text-admin-ink">
        {label}
        {required ? (
          <span className="ml-0.5 text-[#c23434]" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {children({ id, describedBy: describedBy || undefined })}

      {hint && !error ? (
        <p id={`${id}-hint`} className="text-[0.6875rem] leading-relaxed text-admin-muted">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[0.6875rem] text-[#c23434]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------- input */

export interface AdminInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "className" | "id"> {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  /** Rendered inside the field, e.g. a currency symbol. */
  prefix?: string;
}

export function AdminInput({
  label,
  hint,
  error,
  required,
  className,
  prefix,
  ...rest
}: AdminInputProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {({ id, describedBy }) => (
        <div className="relative">
          {prefix ? (
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[0.8125rem] text-admin-muted">
              {prefix}
            </span>
          ) : null}
          <input
            id={id}
            required={required}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            className={cn(CONTROL, "h-9", error ? BORDER_ERROR : BORDER, prefix && "pl-6")}
            {...rest}
          />
        </div>
      )}
    </Field>
  );
}

/* ----------------------------------------------------------------- textarea */

export function AdminTextarea({
  label,
  hint,
  error,
  required,
  className,
  rows = 4,
  ...rest
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "className" | "id"> & {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {({ id, describedBy }) => (
        <textarea
          id={id}
          rows={rows}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(CONTROL, "py-2 leading-relaxed", error ? BORDER_ERROR : BORDER)}
          {...rest}
        />
      )}
    </Field>
  );
}

/* ------------------------------------------------------------------- select */

export function AdminSelect({
  label,
  hint,
  error,
  required,
  className,
  options,
  placeholder,
  ...rest
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "className" | "id" | "children"> & {
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  placeholder?: string;
  options: { value: string; label: string }[];
}) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={className}>
      {({ id, describedBy }) => (
        <select
          id={id}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(CONTROL, "h-9 cursor-pointer", error ? BORDER_ERROR : BORDER)}
          {...rest}
        >
          {placeholder ? <option value="">{placeholder}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/* ---------------------------------------------------------------- checkbox */

export function AdminCheckbox({
  label,
  description,
  className,
  ...rest
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "className" | "type"> & {
  label: string;
  description?: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 py-1",
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
        className,
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-copper-600"
        {...rest}
      />
      <span className="min-w-0">
        <span className="block text-[0.8125rem] text-admin-ink">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-admin-muted">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/** A checkbox styled as a switch, for settings that read as on/off. */
export function AdminToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start justify-between gap-4 py-2",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
    >
      <span className="min-w-0">
        <span className="block text-[0.8125rem] text-admin-ink">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-admin-muted">
            {description}
          </span>
        ) : null}
      </span>

      <span className="relative mt-0.5 shrink-0">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            "block h-5 w-9 rounded-pill transition-colors",
            checked ? "bg-copper-600" : "bg-admin-border-strong",
            "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-copper-600",
          )}
        />
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0.5 top-0.5 block h-4 w-4 rounded-pill bg-white shadow-subtle transition-transform",
            checked && "translate-x-4",
          )}
        />
      </span>
    </label>
  );
}

/* ------------------------------------------------------------- form layout */

export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[3px] border border-admin-border bg-admin-surface p-4 sm:p-5",
        className,
      )}
    >
      <header className="mb-4">
        <h2 className="font-sans text-sm font-semibold tracking-normal text-admin-ink">
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-admin-muted">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** A two-column grid that collapses to one on narrow screens. */
export function FormGrid({
  columns = 2,
  children,
  className,
}: {
  columns?: 1 | 2 | 3;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- list editors */

/**
 * A list of free-text values, entered one at a time.
 *
 * Used for tags and sizes. Values are added on Enter rather than parsed from a
 * comma-separated string, so a value containing a comma is still possible.
 */
export function TagListInput({
  label,
  hint,
  values,
  onChange,
  placeholder = "Type and press Enter",
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value || values.includes(value)) {
      setDraft("");
      return;
    }
    onChange([...values, value]);
    setDraft("");
  };

  return (
    <Field label={label} hint={hint}>
      {({ id }) => (
        <div>
          <div className="flex gap-2">
            <input
              id={id}
              value={draft}
              placeholder={placeholder}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
              className={cn(CONTROL, "h-9", BORDER)}
            />
            <button
              type="button"
              onClick={add}
              aria-label={`Add to ${label.toLowerCase()}`}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[3px] border border-admin-border-strong text-admin-ink transition-colors hover:bg-admin-raised"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>

          {values.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {values.map((value) => (
                <li key={value}>
                  <span className="inline-flex items-center gap-1 rounded-[3px] bg-admin-raised px-2 py-1 text-[0.6875rem] text-admin-ink ring-1 ring-inset ring-admin-border">
                    {value}
                    <button
                      type="button"
                      onClick={() => onChange(values.filter((entry) => entry !== value))}
                      aria-label={`Remove ${value}`}
                      className="text-admin-faint transition-colors hover:text-[#c23434]"
                    >
                      <X className="h-3 w-3" strokeWidth={2.5} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Field>
  );
}

/**
 * Image management.
 *
 * Takes URLs rather than file uploads, because uploading needs somewhere to
 * upload *to*, and this store has no object storage. A file picker that only
 * produced a temporary blob URL would look like it worked and then break on
 * the next reload, which is worse than being honest about it.
 *
 * When a bucket exists, this component gains a file input and posts to it; the
 * rest of the form is unaffected since it only ever sees a list of URLs.
 */
export function ImageListInput({
  label,
  values,
  onChange,
  error,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  error?: string;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const url = draft.trim();
    if (!url || values.includes(url)) {
      setDraft("");
      return;
    }
    onChange([...values, url]);
    setDraft("");
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    const moved = next[index]!;
    next[index] = next[target]!;
    next[target] = moved;
    onChange(next);
  };

  return (
    <Field
      label={label}
      error={error}
      hint="Paste an image URL. The first image is the one shown on product cards."
    >
      {({ id }) => (
        <div>
          <div className="flex gap-2">
            <input
              id={id}
              type="url"
              value={draft}
              placeholder="https://images.unsplash.com/photo-..."
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
              className={cn(CONTROL, "h-9", error ? BORDER_ERROR : BORDER)}
            />
            <button
              type="button"
              onClick={add}
              aria-label="Add image"
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[3px] border border-admin-border-strong px-3 text-xs text-admin-ink transition-colors hover:bg-admin-raised"
            >
              <ImagePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
              Add
            </button>
          </div>

          {values.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {values.map((url, index) => (
                <li key={url} className="relative">
                  <span className="block h-20 w-16 overflow-hidden rounded-[3px] border border-admin-border bg-admin-raised">
                    {/* A plain img: these are arbitrary user-entered URLs, and
                        next/image would reject any host not in remotePatterns. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt={`${label} ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </span>

                  {index === 0 ? (
                    <span className="absolute left-0 top-0 bg-admin-ink px-1 py-0.5 text-[0.5625rem] font-medium text-white">
                      MAIN
                    </span>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => onChange(values.filter((entry) => entry !== url))}
                    aria-label={`Remove image ${index + 1}`}
                    className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-pill bg-[#c23434] text-white"
                  >
                    <X className="h-3 w-3" strokeWidth={3} />
                  </button>

                  <span className="mt-1 flex justify-center gap-1">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move image ${index + 1} earlier`}
                      className="text-[0.625rem] text-admin-muted disabled:opacity-30"
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === values.length - 1}
                      aria-label={`Move image ${index + 1} later`}
                      className="text-[0.625rem] text-admin-muted disabled:opacity-30"
                    >
                      →
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Field>
  );
}
