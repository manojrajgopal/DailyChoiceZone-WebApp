"use client";

import Link from "next/link";
import { X } from "lucide-react";

import { IdAutocomplete } from "@/components/common/IdAutocomplete";
import { adminLookupHref, idLabel as labelFor, idPlaceholder, type LookupEntity } from "@/lib/lookup/entities";
import { cn } from "@/lib/utils/cn";

/**
 * A list's "find this one" box (docs/id-lookup.md): an ID, chosen from the
 * autocomplete, that narrows the list to exactly that record — or to the rows
 * that point at it ("Customer ID" on an orders list).
 *
 *   <IdFilter entity="order" value={filters.q} onChange={(q) => setFilters({ ...filters, q })} />
 *
 * Not a text search: names and emails are not IDs, and the list's endpoint
 * matches the ID exactly. Empty: the autocomplete. Set: a chip that says which
 * ID is filtering, with a link to that record and × to remove it.
 */
export function IdFilter({
  entity,
  value,
  onChange,
  label,
  className,
}: {
  entity: LookupEntity;
  value: string;
  onChange: (id: string) => void;
  /** "Customer ID" by default. */
  label?: string;
  className?: string;
}) {
  const fieldLabel = label ?? labelFor(entity);

  if (value) {
    return (
      <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
        <span className="text-xs font-medium text-admin-ink">{fieldLabel}</span>
        <div
          className="flex h-9 items-center gap-2 rounded-[3px] border border-copper-500 bg-admin-surface px-2.5 text-[0.8125rem]"
          role="group"
          aria-label={`Filtered by ${fieldLabel} ${value}`}
        >
          <Link href={adminLookupHref(entity, value)} className="min-w-0 truncate font-mono text-admin-ink hover:underline">
            {value}
          </Link>
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label={`Remove ${fieldLabel} filter`}
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-admin-muted hover:bg-admin-raised hover:text-admin-ink"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <IdAutocomplete
      entity={entity}
      label={fieldLabel}
      placeholder={idPlaceholder(entity)}
      className={className}
      onSelect={(id) => onChange(id)}
    />
  );
}
