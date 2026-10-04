"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { IdAutocomplete } from "@/components/common/IdAutocomplete";
import { IdPreviewCard } from "@/components/common/IdPreviewCard";
import { AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminSelect } from "@/components/admin/ui/AdminForm";
import { isLookupEntity, LOOKUP_ENTITIES, type LookupEntity } from "@/lib/lookup/entities";
import { lookupErrorMessage } from "@/lib/lookup/errors";
import { listLookupEntities, type LookupEntityInfo } from "@/services/lookupService";

/**
 * The portal's ID lookup (docs/id-lookup.md): pick what kind of record, type
 * its ID, see its main details, open it.
 *
 * Every ID shown elsewhere in the portal can link here
 * (`/admin/lookup?entity=order&id=DCZ10241`), so "click an ID, see that
 * record" works the same for every entity — including the ones without a
 * screen of their own. Only the entities this role may open are offered.
 */
export function AdminLookupView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const wanted = params.get("entity");
  const entity: LookupEntity = isLookupEntity(wanted) ? wanted : "order";
  const id = params.get("id") ?? "";

  const [entities, setEntities] = useState<LookupEntityInfo[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listLookupEntities("admin", controller.signal)
      .then((items) => setEntities(items))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setProblem(lookupErrorMessage(error, { idLabel: "ID" }));
      });
    return () => controller.abort();
  }, []);

  const go = (next: { entity?: LookupEntity; id?: string }) => {
    const search = new URLSearchParams();
    search.set("entity", next.entity ?? entity);
    if (next.id) search.set("id", next.id);
    router.replace(`${pathname}?${search.toString()}`, { scroll: false });
  };

  const options = (entities ?? []).map((item) => ({ value: item.entity, label: item.idLabel }));
  // Until the list arrives nothing is fetched; if it cannot arrive, the server
  // still refuses what the role may not open.
  const ready = entities !== null || problem !== null;
  const allowed = entities === null ? problem !== null : entities.some((item) => item.entity === entity);
  const label = LOOKUP_ENTITIES[entity].label;

  return (
    <>
      <AdminPageHeader
        title="ID lookup"
        description="Find any record by its ID. Matching is on IDs and document numbers only — never names."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "ID lookup" }]}
      />

      <AdminCard padded>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <AdminSelect
            label="Record type"
            value={entity}
            onChange={(event) => go({ entity: event.target.value as LookupEntity })}
            options={options.length > 0 ? options : [{ value: entity, label: `${label} ID` }]}
            disabled={entities === null}
          />
          {!ready ? null : allowed ? (
            <IdAutocomplete
              key={entity}
              entity={entity}
              hint={`For example ${LOOKUP_ENTITIES[entity].example}. Press Enter to open an exact ID.`}
              onSelect={(chosen) => go({ id: chosen })}
            />
          ) : (
            <p role="alert" className="self-end text-xs text-[#c23434]">
              Your role doesn&apos;t include {label.toLowerCase()} records.
            </p>
          )}
        </div>
        {problem ? (
          <p role="alert" className="mt-3 text-xs text-[#c23434]">
            {problem}
          </p>
        ) : null}
      </AdminCard>

      {id && allowed ? (
        <div className="mt-4 max-w-2xl">
          <IdPreviewCard entity={entity} id={id} onClear={() => go({})} />
        </div>
      ) : null}
    </>
  );
}
