"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { Modal } from "@/components/ui/Dialog";
import { cn } from "@/lib/utils/cn";
import { slugify } from "@/lib/utils/format";
import { createAttribute, updateAttribute } from "@/services/admin/searchAdminService";
import { toast } from "@/store/toastStore";
import type { AttributeInput, AttributeType, ProductAttribute } from "@/types/searchAdmin";

import { CODE_PATTERN, TYPE_LABELS, codeFromLabel, errorCode, friendlyError } from "./shared";

interface OptionRow {
  key: string;
  id?: number;
  label: string;
  value: string;
}

interface Draft {
  label: string;
  code: string;
  type: AttributeType;
  unit: string;
  filterable: boolean;
  searchable: boolean;
  position: string;
  options: OptionRow[];
}

let rowSeq = 0;
const nextKey = () => `new-${(rowSeq += 1)}`;

function toDraft(attribute: ProductAttribute | null): Draft {
  if (!attribute) {
    return { label: "", code: "", type: "select", unit: "", filterable: true, searchable: true, position: "0", options: [] };
  }
  return {
    label: attribute.label,
    code: attribute.code,
    type: attribute.type,
    unit: attribute.unit,
    filterable: attribute.filterable,
    searchable: attribute.searchable,
    position: String(attribute.position),
    options: [...attribute.options]
      .sort((a, b) => a.position - b.position)
      .map((option) => ({ key: `id-${option.id}`, id: option.id, label: option.label, value: option.value })),
  };
}

const ICON_BUTTON =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink disabled:cursor-not-allowed disabled:opacity-30";

/**
 * Create or edit an attribute. The code and type are fixed by the server once
 * any product has a value, so they lock here when the attribute is in use.
 */
export function AttributeDialog({
  open,
  attribute,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  /** null to create. */
  attribute: ProductAttribute | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (attribute: ProductAttribute) => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={attribute ? `Edit ${attribute.label}` : "New attribute"}
      className="max-w-2xl"
    >
      {open ? (
        <AttributeForm
          key={attribute?.id ?? "new"}
          attribute={attribute}
          onCancel={() => onOpenChange(false)}
          onSaved={onSaved}
        />
      ) : null}
    </Modal>
  );
}

function AttributeForm({
  attribute,
  onCancel,
  onSaved,
}: {
  attribute: ProductAttribute | null;
  onCancel: () => void;
  onSaved: (attribute: ProductAttribute) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(attribute));
  const [codeTouched, setCodeTouched] = useState(Boolean(attribute));
  const [errors, setErrors] = useState<Partial<Record<"label" | "code" | "position" | "options" | "form", string>>>({});
  const [saving, setSaving] = useState(false);

  const inUse = Boolean(attribute && attribute.productCount > 0);
  const hasOptions = draft.type === "select" || draft.type === "multi";

  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  const setOption = (key: string, next: Partial<OptionRow>) =>
    patch({ options: draft.options.map((row) => (row.key === key ? { ...row, ...next } : row)) });

  const moveOption = (index: number, by: -1 | 1) => {
    const options = [...draft.options];
    const [row] = options.splice(index, 1);
    options.splice(index + by, 0, row!);
    patch({ options });
  };

  const validate = (): typeof errors => {
    const found: typeof errors = {};
    if (!draft.label.trim()) found.label = "Give the attribute a label.";
    if (!CODE_PATTERN.test(draft.code)) {
      found.code = "2–40 lower-case letters, digits or _, starting with a letter.";
    }
    const position = Number(draft.position);
    if (!Number.isInteger(position) || position < 0 || position > 10_000) {
      found.position = "A whole number from 0 to 10,000.";
    }
    if (hasOptions) {
      if (draft.options.some((row) => !row.label.trim())) found.options = "Every option needs a label.";
      const values = draft.options.map((row) => slugify(row.value.trim() || row.label));
      const duplicate = values.find((value, index) => value && values.indexOf(value) !== index);
      if (!found.options && duplicate) found.options = `“${duplicate}” is in the list twice.`;
    }
    return found;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const input: AttributeInput = {
      label: draft.label.trim(),
      unit: draft.type === "number" ? draft.unit.trim() : "",
      filterable: draft.filterable,
      searchable: draft.searchable,
      position: Number(draft.position),
      options: hasOptions
        ? draft.options.map((row) =>
            row.id !== undefined
              ? { id: row.id, label: row.label.trim() }
              : { label: row.label.trim(), ...(row.value.trim() ? { value: row.value.trim() } : {}) },
          )
        : [],
    };
    if (!attribute || draft.code !== attribute.code) input.code = draft.code;
    if (!attribute || draft.type !== attribute.type) input.type = draft.type;
    if (!attribute) input.status = "active";

    setSaving(true);
    try {
      const saved = attribute ? await updateAttribute(attribute.id, input) : await createAttribute(input);
      toast.success(attribute ? `${saved.label} saved` : `${saved.label} created`);
      onSaved(saved);
    } catch (error) {
      const message = friendlyError(error, "The attribute wasn't saved. Please try again.");
      const code = errorCode(error);
      if (code === "ATTRIBUTE_CODE_TAKEN" || code === "INVALID_ATTRIBUTE_CODE") setErrors({ code: message });
      else if (code === "ATTRIBUTE_LABEL_REQUIRED") setErrors({ label: message });
      else if (["OPTION_IN_USE", "DUPLICATE_OPTION", "INVALID_OPTIONS", "OPTIONS_NOT_ALLOWED"].includes(code)) {
        setErrors({ options: message });
      } else setErrors({ form: message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
      {errors.form ? (
        <p role="alert" className="rounded-[3px] border border-[#f1c4c4] bg-[#fbeaea] px-3 py-2 text-xs text-[#a12b2b]">
          {errors.form}
        </p>
      ) : null}

      <FormGrid>
        <AdminInput
          label="Label"
          required
          value={draft.label}
          maxLength={80}
          error={errors.label}
          hint="What shoppers see, e.g. “Material”."
          onChange={(event) => {
            const label = event.target.value;
            patch(codeTouched ? { label } : { label, code: codeFromLabel(label) });
          }}
        />
        <AdminInput
          label="Code"
          required
          value={draft.code}
          maxLength={40}
          disabled={inUse}
          error={errors.code}
          hint={
            inUse
              ? "Fixed: products use this attribute, and links to filters use the code."
              : "Used in filter links (attr.code=value). Lower-case letters, digits and _."
          }
          onChange={(event) => {
            setCodeTouched(true);
            patch({ code: event.target.value.toLowerCase() });
          }}
        />
        <AdminSelect
          label="Type"
          value={draft.type}
          disabled={inUse}
          hint={inUse ? "Fixed: products use this attribute." : undefined}
          onChange={(event) => patch({ type: event.target.value as AttributeType })}
          options={(Object.keys(TYPE_LABELS) as AttributeType[]).map((type) => ({ value: type, label: TYPE_LABELS[type] }))}
        />
        {draft.type === "number" ? (
          <AdminInput
            label="Unit"
            value={draft.unit}
            maxLength={20}
            hint="Shown after the number, e.g. cm, g, mAh."
            onChange={(event) => patch({ unit: event.target.value })}
          />
        ) : null}
        <AdminInput
          label="Position"
          type="number"
          min={0}
          max={10000}
          step={1}
          value={draft.position}
          error={errors.position}
          hint="Lower numbers are listed first."
          onChange={(event) => patch({ position: event.target.value })}
        />
      </FormGrid>

      <div className="divide-y divide-admin-border rounded-[3px] border border-admin-border px-3">
        <AdminToggle
          label="Filterable"
          description="Offer it as a filter on listing and search pages."
          checked={draft.filterable}
          onChange={(filterable) => patch({ filterable })}
        />
        <AdminToggle
          label="Searchable"
          description="Match search terms against this attribute's values."
          checked={draft.searchable}
          onChange={(searchable) => patch({ searchable })}
        />
      </div>

      {hasOptions ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-medium text-admin-ink">Options</legend>
          {draft.options.length === 0 ? (
            <p className="text-xs text-admin-muted">No options yet. Add the choices products can have.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {draft.options.map((row, index) => (
                <li key={row.key} className="flex items-start gap-2">
                  <span className="mt-2 w-5 shrink-0 text-right text-[0.6875rem] tabular-nums text-admin-faint">
                    {index + 1}
                  </span>
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">Option {index + 1} label</span>
                    <input
                      value={row.label}
                      maxLength={120}
                      placeholder="Label, e.g. Stainless steel"
                      onChange={(event) => setOption(row.key, { label: event.target.value })}
                      className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-surface px-2.5 text-[0.8125rem] text-admin-ink placeholder:text-admin-faint hover:border-admin-border-strong focus:border-copper-500"
                    />
                  </label>
                  <label className="w-40 shrink-0">
                    <span className="sr-only">Option {index + 1} value</span>
                    <input
                      value={row.value}
                      readOnly={row.id !== undefined}
                      maxLength={120}
                      placeholder={slugify(row.label) || "value"}
                      title={row.id !== undefined ? "An existing option keeps its value; rename its label instead." : undefined}
                      onChange={(event) => setOption(row.key, { value: event.target.value })}
                      className={cn(
                        "h-8 w-full rounded-[3px] border border-admin-border px-2.5 font-mono text-[0.75rem] text-admin-ink placeholder:text-admin-faint",
                        row.id !== undefined ? "bg-admin-raised text-admin-muted" : "bg-admin-surface hover:border-admin-border-strong focus:border-copper-500",
                      )}
                    />
                  </label>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    onClick={() => moveOption(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${row.label || `option ${index + 1}`} up`}
                  >
                    <ArrowUp className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={ICON_BUTTON}
                    onClick={() => moveOption(index, 1)}
                    disabled={index === draft.options.length - 1}
                    aria-label={`Move ${row.label || `option ${index + 1}`} down`}
                  >
                    <ArrowDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={cn(ICON_BUTTON, "hover:bg-[#fbeaea] hover:text-[#a32424]")}
                    onClick={() => patch({ options: draft.options.filter((entry) => entry.key !== row.key) })}
                    aria-label={`Remove ${row.label || `option ${index + 1}`}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          {errors.options ? (
            <p role="alert" className="text-[0.6875rem] text-[#c23434]">
              {errors.options}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <AdminButton
              size="sm"
              onClick={() => patch({ options: [...draft.options, { key: nextKey(), label: "", value: "" }] })}
              disabled={draft.options.length >= 200}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              Add option
            </AdminButton>
            <span className="text-[0.6875rem] text-admin-muted">
              The value is what filter links use; leave it blank to derive it from the label.
            </span>
          </div>
        </fieldset>
      ) : null}

      <div className="mt-2 flex justify-end gap-2">
        <AdminButton onClick={onCancel} disabled={saving}>
          Cancel
        </AdminButton>
        <AdminButton type="submit" variant="primary" loading={saving}>
          {attribute ? "Save attribute" : "Create attribute"}
        </AdminButton>
      </div>
    </form>
  );
}
