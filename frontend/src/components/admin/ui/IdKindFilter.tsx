"use client";

import { IdFilter } from "@/components/admin/ui/IdFilter";
import { idLabel, type LookupEntity } from "@/lib/lookup/entities";
import { cn } from "@/lib/utils/cn";

/**
 * One list filter that takes any of a few related IDs (docs/id-lookup.md) —
 * a payments list found by its Payment ID, its Order ID or its Invoice ID.
 *
 *   <IdKindFilter kinds={["payment", "order", "invoice"]} entity={kind} value={id}
 *                 onChange={({ entity, id }) => { setKind(entity); setId(id); }} />
 *
 * Which ID is being given is chosen first, so the autocomplete suggests only
 * that entity's IDs; the chosen ID goes to the list's endpoint, which matches
 * it exactly. Switching the kind clears the ID.
 */
export function IdKindFilter({
  kinds,
  entity,
  value,
  onChange,
  className,
}: {
  kinds: readonly LookupEntity[];
  entity: LookupEntity;
  value: string;
  onChange: (next: { entity: LookupEntity; id: string }) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-end gap-2", className)}>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-admin-ink">Find by</span>
        <select
          value={entity}
          onChange={(event) => onChange({ entity: event.target.value as LookupEntity, id: "" })}
          aria-label="Which ID to find by"
          className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] text-admin-ink hover:border-admin-border-strong focus:border-copper-500"
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {idLabel(kind)}
            </option>
          ))}
        </select>
      </label>
      <IdFilter
        key={entity}
        entity={entity}
        value={value}
        onChange={(id) => onChange({ entity, id })}
        className="min-w-[14rem] flex-1"
      />
    </div>
  );
}
