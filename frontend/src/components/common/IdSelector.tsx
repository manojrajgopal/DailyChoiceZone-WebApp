"use client";

import { useRef, useState } from "react";
import { X } from "lucide-react";

import { IdAutocomplete, type IdAutocompleteHandle, type IdAutocompleteProps } from "@/components/common/IdAutocomplete";
import { IdPreviewCard } from "@/components/common/IdPreviewCard";
import { idLabel as labelFor } from "@/lib/lookup/entities";
import { cn } from "@/lib/utils/cn";
import type { IdPreview } from "@/services/lookupService";

/**
 * One relationship field, chosen by ID (docs/id-lookup.md):
 *
 *   <IdSelector entity="supplier" value={supplierId} onChange={setSupplierId} />
 *
 * Empty: the ID autocomplete. Chosen: the record's preview, with Change (pick
 * another; Escape keeps this one) and Clear.
 */
export interface IdSelectorProps
  extends Omit<IdAutocompleteProps, "onSelect" | "onCancel" | "exclude" | "autoFocus"> {
  value: string | null | undefined;
  onChange: (id: string | null, preview?: IdPreview | null) => void;
  /** Without a preview: just the chosen ID, with Change and Clear. */
  compact?: boolean;
  /** Clearing is not allowed (a required field that already has a value). */
  clearable?: boolean;
  /** Told when the chosen ID's preview has loaded — to copy a price, say. */
  onPreview?: (preview: IdPreview | null) => void;
  heading?: string;
}

export function IdSelector({
  value,
  onChange,
  compact = false,
  clearable = true,
  onPreview,
  heading,
  ...autocomplete
}: IdSelectorProps) {
  const [changing, setChanging] = useState(false);
  const inputRef = useRef<IdAutocompleteHandle>(null);
  const { entity, scope = "admin", tone = "admin" } = autocomplete;
  const label = autocomplete.label ?? labelFor(entity);

  if (!value || changing) {
    return (
      <IdAutocomplete
        ref={inputRef}
        {...autocomplete}
        autoFocus={changing}
        onCancel={changing ? () => setChanging(false) : undefined}
        hint={changing ? "Press Escape to keep the current one." : autocomplete.hint}
        onSelect={(id, preview) => {
          setChanging(false);
          onChange(id, preview ?? null);
        }}
      />
    );
  }

  const change = () => setChanging(true);
  const clear = clearable ? () => onChange(null, null) : undefined;

  if (compact) {
    return (
      <div className={cn("flex flex-col gap-1.5", autocomplete.className)}>
        <span className={tone === "admin" ? "text-xs font-medium text-admin-ink" : "label-wide text-ink-700"}>
          {label}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[0.8125rem] text-admin-ink">{value}</span>
          <button type="button" onClick={change} className="text-xs text-copper-600 hover:underline" aria-label={`Change ${label}`}>
            Change
          </button>
          {clear ? (
            <button type="button" onClick={clear} aria-label={`Clear ${label}`} className="text-admin-muted hover:text-admin-ink">
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-1.5", autocomplete.className)}>
      {autocomplete.hideLabel ? null : (
        <span className={tone === "admin" ? "text-xs font-medium text-admin-ink" : "label-wide text-ink-700"}>
          {label}
        </span>
      )}
      <IdPreviewCard
        entity={entity}
        id={value}
        scope={scope}
        tone={tone}
        heading={heading}
        onChange={change}
        onClear={clear}
        onLoaded={onPreview}
      />
    </div>
  );
}
