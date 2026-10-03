"use client";

import Link from "next/link";
import { useState } from "react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminToggle, FormGrid, FormSection } from "@/components/admin/ui/AdminForm";
import { useAdminResource } from "@/hooks/useAdminResource";
import { getProductAttributes, setProductAttributes } from "@/services/admin/searchAdminService";
import { toast } from "@/store/toastStore";
import type { AttributeValue, ProductAttributeEntry, ProductAttributeValues } from "@/types/searchAdmin";

import { errorCode, friendlyError, isForbidden } from "./shared";

/** What the form holds per code: numbers as typed text, so a half-typed "1." survives. */
type FormValue = string | string[] | boolean | null;

function toForm(entry: ProductAttributeEntry): FormValue {
  if (entry.type === "multi") return Array.isArray(entry.value) ? entry.value : [];
  if (entry.type === "number") return entry.value === null || entry.value === undefined ? "" : String(entry.value);
  if (entry.type === "boolean") return typeof entry.value === "boolean" ? entry.value : null;
  return typeof entry.value === "string" ? entry.value : "";
}

function toApi(entry: ProductAttributeEntry, value: FormValue): AttributeValue {
  if (entry.type === "number") {
    const text = typeof value === "string" ? value.trim() : "";
    return text === "" ? null : Number(text);
  }
  if (entry.type === "select") return value || null;
  return value;
}

function same(a: FormValue, b: FormValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A product's attribute values, on its edit page. Saved on their own button:
 * they go to their own endpoint, and only the values changed are sent.
 */
export function ProductAttributesPanel({ productId }: { productId: string }) {
  const state = useAdminResource(() => getProductAttributes(productId), [productId], { enabled: Boolean(productId) });
  const [version, setVersion] = useState(0);

  return (
    <FormSection
      title="Attributes"
      description="Properties shoppers filter and search by. Only active attributes are listed."
    >
      {isForbidden(state.error) ? (
        <p role="alert" className="text-xs text-admin-muted">Your role doesn&apos;t include managing attributes.</p>
      ) : state.error && !state.data ? (
        <div role="alert" className="text-xs text-admin-ink">
          The attributes didn&rsquo;t load.
          <AdminButton size="sm" className="ml-2" onClick={() => void state.reload()}>
            Try again
          </AdminButton>
        </div>
      ) : !state.data ? (
        <span aria-busy="true" aria-label="Loading attributes" className="block h-24 w-full animate-pulse rounded-[2px] bg-admin-border" />
      ) : state.data.attributes.length === 0 ? (
        <p className="text-xs text-admin-muted">
          No attributes yet.{" "}
          <Link href="/admin/attributes" className="text-copper-700 underline underline-offset-2">
            Create attributes
          </Link>{" "}
          such as Material or Sleeve length to set them here.
        </p>
      ) : (
        <ValuesForm
          key={version}
          productId={productId}
          data={state.data}
          onSaved={() => setVersion((current) => current + 1)}
          reload={state.reload}
        />
      )}
    </FormSection>
  );
}

function ValuesForm({
  productId,
  data,
  onSaved,
  reload,
}: {
  productId: string;
  data: ProductAttributeValues;
  onSaved: () => void;
  reload: () => Promise<void>;
}) {
  const initial = Object.fromEntries(data.attributes.map((entry) => [entry.code, toForm(entry)]));
  const [values, setValues] = useState<Record<string, FormValue>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const changed = data.attributes.filter((entry) => !same(values[entry.code] ?? null, initial[entry.code] ?? null));
  const set = (code: string, value: FormValue) => setValues((current) => ({ ...current, [code]: value }));

  const save = async () => {
    const found: Record<string, string> = {};
    for (const entry of changed) {
      if (entry.type !== "number") continue;
      const text = String(values[entry.code] ?? "").trim();
      if (text !== "" && !Number.isFinite(Number(text))) found[entry.code] = `${entry.label} needs a number.`;
    }
    setErrors(found);
    setFormError("");
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    try {
      await setProductAttributes(
        productId,
        Object.fromEntries(changed.map((entry) => [entry.code, toApi(entry, values[entry.code] ?? null)])),
      );
      toast.success("Attributes saved");
      await reload();
      onSaved();
    } catch (error) {
      setFormError(
        errorCode(error) === "UNKNOWN_ATTRIBUTE"
          ? "An attribute was removed meanwhile. Reload the page and try again."
          : friendlyError(error, "The attributes weren't saved. Please try again."),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <FormGrid>
        {data.attributes.map((entry) => (
          <AttributeField
            key={entry.code}
            entry={entry}
            value={values[entry.code] ?? null}
            error={errors[entry.code]}
            onChange={(value) => set(entry.code, value)}
          />
        ))}
      </FormGrid>

      {formError ? (
        <p role="alert" className="rounded-[3px] border border-[#f1c4c4] bg-[#fbeaea] px-3 py-2 text-xs text-[#a12b2b]">
          {formError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-[0.6875rem] text-admin-muted">
          {changed.length === 0 ? "No unsaved changes" : `${changed.length} unsaved ${changed.length === 1 ? "change" : "changes"}`}
        </span>
        <AdminButton variant="primary" size="sm" onClick={() => void save()} loading={saving} disabled={changed.length === 0}>
          Save attributes
        </AdminButton>
      </div>
    </div>
  );
}

function AttributeField({
  entry,
  value,
  error,
  onChange,
}: {
  entry: ProductAttributeEntry;
  value: FormValue;
  error?: string;
  onChange: (value: FormValue) => void;
}) {
  const options = [...entry.options].sort((a, b) => a.position - b.position);

  if (entry.type === "select") {
    return (
      <AdminSelect
        label={entry.label}
        value={typeof value === "string" ? value : ""}
        placeholder="Not set"
        options={options.map((option) => ({ value: option.value, label: option.label }))}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (entry.type === "multi") {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="min-w-0">
        <legend className="mb-1 text-xs font-medium text-admin-ink">{entry.label}</legend>
        {options.length === 0 ? (
          <p className="text-[0.6875rem] text-admin-muted">This attribute has no options yet.</p>
        ) : (
          <div className="flex flex-wrap gap-x-4">
            {options.map((option) => (
              <AdminCheckbox
                key={option.value}
                label={option.label}
                checked={chosen.includes(option.value)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? options.map((o) => o.value).filter((v) => v === option.value || chosen.includes(v))
                      : chosen.filter((v) => v !== option.value),
                  )
                }
              />
            ))}
          </div>
        )}
      </fieldset>
    );
  }

  if (entry.type === "number") {
    return (
      <AdminInput
        label={entry.unit ? `${entry.label} (${entry.unit})` : entry.label}
        type="number"
        inputMode="decimal"
        step="any"
        value={typeof value === "string" ? value : ""}
        error={error}
        placeholder="Not set"
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  // boolean: on, off, or not set (so "no" is a fact, not a default).
  return (
    <div className="min-w-0">
      <AdminToggle
        label={entry.label}
        description={value === null ? "Not set" : value ? "Yes" : "No"}
        checked={value === true}
        onChange={(checked) => onChange(checked)}
      />
      {value !== null ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[0.6875rem] text-admin-muted underline underline-offset-2 hover:text-admin-ink"
        >
          Clear {entry.label}
        </button>
      ) : null}
    </div>
  );
}
