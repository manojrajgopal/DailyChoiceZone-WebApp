"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea, AdminToggle } from "@/components/admin/ui/AdminForm";

/**
 * A list of records, edited in place.
 *
 * The store's configuration is mostly lists of small objects — delivery
 * methods, contact topics, FAQ entries, size charts, menu links — and each one
 * needs the same four things: add a row, edit its fields, reorder it, remove
 * it. Written once here rather than fifteen times across the settings screens.
 *
 * Rows are held by the parent and returned whole on every change, so the page
 * owns the draft and one Save writes the document. That matters: these are
 * *documents*, and saving half a menu would leave the storefront with a menu
 * that is half a menu.
 *
 * Reordering is explicit arrows rather than drag-and-drop. Order is meaningful
 * here — it is the order a customer sees — and arrows work from a keyboard,
 * on a phone, and with a screen reader, which a drag handle does not.
 */

export interface FieldSpec<T> {
  /** The key on the record. */
  key: keyof T & string;
  label: string;
  kind?: "text" | "number" | "textarea" | "toggle" | "select";
  /** For `select`. */
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  /** Narrow fields sit two to a row on a wide screen. */
  span?: "half" | "full";
}

export function RecordListEditor<T extends object>({
  rows,
  onChange,
  fields,
  blank,
  addLabel = "Add",
  emptyMessage = "Nothing here yet.",
  title,
}: {
  rows: T[];
  onChange: (rows: T[]) => void;
  fields: FieldSpec<T>[];
  /** A new, empty record. A function so each row gets its own object. */
  blank: () => T;
  addLabel?: string;
  emptyMessage?: string;
  /** How a row names itself in its own heading, e.g. `(row) => row.label`. */
  title?: (row: T, index: number) => string;
}) {
  const patch = (index: number, key: string, value: unknown) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));

  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));

  /** Swap with the neighbour. Nothing happens at either end. */
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;

    const next = [...rows];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-xs text-admin-muted">{emptyMessage}</p>
      ) : null}

      {rows.map((row, index) => (
        <div
          key={index}
          className="rounded-[3px] border border-admin-border bg-admin-surface p-3.5"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
              {title?.(row, index) || `Item ${index + 1}`}
            </p>

            <div className="flex shrink-0 items-center gap-1">
              <IconButton
                label={`Move ${title?.(row, index) || `item ${index + 1}`} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.75} />
              </IconButton>
              <IconButton
                label={`Move ${title?.(row, index) || `item ${index + 1}`} down`}
                disabled={index === rows.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.75} />
              </IconButton>
              <IconButton
                label={`Remove ${title?.(row, index) || `item ${index + 1}`}`}
                onClick={() => remove(index)}
                destructive
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </IconButton>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <div
                key={field.key}
                className={field.span === "full" || field.kind === "textarea" ? "sm:col-span-2" : ""}
              >
                <RowField field={field} row={row} onPatch={(value) => patch(index, field.key, value)} />
              </div>
            ))}
          </div>
        </div>
      ))}

      <div>
        <AdminButton variant="secondary" onClick={() => onChange([...rows, blank()])}>
          <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          {addLabel}
        </AdminButton>
      </div>
    </div>
  );
}

function RowField<T extends object>({
  field,
  row,
  onPatch,
}: {
  field: FieldSpec<T>;
  row: T;
  onPatch: (value: unknown) => void;
}) {
  const value = (row as Record<string, unknown>)[field.key];

  if (field.kind === "toggle") {
    return (
      <AdminToggle
        label={field.label}
        description={field.hint}
        checked={Boolean(value)}
        onChange={onPatch}
      />
    );
  }

  if (field.kind === "select") {
    return (
      <AdminSelect
        label={field.label}
        hint={field.hint}
        value={String(value ?? "")}
        onChange={(event) => onPatch(event.target.value)}
        options={field.options ?? []}
      />
    );
  }

  if (field.kind === "textarea") {
    return (
      <AdminTextarea
        label={field.label}
        hint={field.hint}
        rows={3}
        value={String(value ?? "")}
        placeholder={field.placeholder}
        onChange={(event) => onPatch(event.target.value)}
      />
    );
  }

  return (
    <AdminInput
      label={field.label}
      hint={field.hint}
      type={field.kind === "number" ? "number" : "text"}
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={field.placeholder}
      onChange={(event) =>
        onPatch(
          field.kind === "number"
            ? // An empty number field is zero, not NaN — the document has to
              // hold a number whatever somebody has half-typed.
              (Number(event.target.value) || 0)
            : event.target.value,
        )
      }
    />
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-[3px] border border-admin-border transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        destructive
          ? "text-admin-muted hover:border-[#c0392b]/40 hover:bg-[#fbeaea] hover:text-[#a32424]"
          : "text-admin-muted hover:bg-admin-raised hover:text-admin-ink"
      }`}
    >
      {children}
    </button>
  );
}
