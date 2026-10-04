"use client";

import { useState } from "react";
import { X } from "lucide-react";

import { IdAutocomplete, type IdAutocompleteProps } from "@/components/common/IdAutocomplete";
import { IdPreviewCard } from "@/components/common/IdPreviewCard";
import { idLabel as labelFor } from "@/lib/lookup/entities";
import { cn } from "@/lib/utils/cn";
import type { IdPreview } from "@/services/lookupService";

/**
 * Several records, each chosen by ID — a coupon's customers, a collection's
 * products, a rule's "purchased any of". Chosen IDs are chips; pressing one
 * shows its preview, × removes it.
 */
export interface IdMultiSelectProps extends Omit<IdAutocompleteProps, "onSelect" | "exclude"> {
  values: readonly string[];
  onChange: (ids: string[]) => void;
  /** Told about each ID as it is added, with its preview when Enter checked it. */
  onAdd?: (id: string, preview?: IdPreview) => void;
  max?: number;
  emptyText?: string;
}

export function IdMultiSelect({ values, onChange, onAdd, max, emptyText, ...autocomplete }: IdMultiSelectProps) {
  const [open, setOpen] = useState<string | null>(null);
  const { entity, scope = "admin", tone = "admin" } = autocomplete;
  const label = autocomplete.label ?? labelFor(entity);
  const full = max !== undefined && values.length >= max;

  const chip =
    tone === "admin"
      ? "inline-flex items-center gap-1 rounded-[3px] border border-admin-border bg-admin-raised px-1.5 py-0.5 font-mono text-[0.6875rem] text-admin-ink"
      : "inline-flex items-center gap-1 rounded-control border border-ink-200 bg-cream-deep px-2 py-0.5 font-mono text-xs text-ink";

  return (
    <div className={cn("flex flex-col gap-2", autocomplete.className)}>
      <IdAutocomplete
        {...autocomplete}
        className={undefined}
        disabled={autocomplete.disabled || full}
        hint={full ? `At most ${max}.` : autocomplete.hint}
        exclude={values}
        onSelect={(id, preview) => {
          onChange([...values, id]);
          onAdd?.(id, preview);
        }}
      />

      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Chosen ${label}s`}>
          {values.map((id) => (
            <li key={id} className={chip}>
              <button
                type="button"
                onClick={() => setOpen((current) => (current === id ? null : id))}
                aria-expanded={open === id}
                aria-label={`Show ${label} ${id}`}
                className="hover:underline"
              >
                {id}
              </button>
              <button
                type="button"
                onClick={() => {
                  onChange(values.filter((value) => value !== id));
                  if (open === id) setOpen(null);
                }}
                aria-label={`Remove ${label} ${id}`}
                className="opacity-70 hover:opacity-100"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : emptyText ? (
        <p className={tone === "admin" ? "text-[0.6875rem] text-admin-muted" : "text-xs text-ink-400"}>{emptyText}</p>
      ) : null}

      {open && values.includes(open) ? (
        <IdPreviewCard entity={entity} id={open} scope={scope} tone={tone} onClear={() => setOpen(null)} />
      ) : null}
    </div>
  );
}
