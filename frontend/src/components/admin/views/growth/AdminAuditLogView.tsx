"use client";

import { useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput } from "@/components/admin/ui/AdminForm";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { FilterSelect, LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Badge, Detail, JsonBlock, TD, TH, TableState, problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { type AuditEntry, exportAuditLog, getAuditEntry, getAuditFacets, listAuditLog } from "@/services/admin/growthAdminService";
import { toast } from "@/store/toastStore";

const KEYS = ["q", "outcome", "resourceType", "actor", "from", "to"] as const;
const OUTCOME: Record<string, { label: string; tone: "green" | "amber" | "red" }> = {
  success: { label: "Done", tone: "green" },
  failure: { label: "Failed", tone: "amber" },
  denied: { label: "Refused", tone: "red" },
};

/**
 * The audit trail: who did what in the portal, recorded by the server.
 * Read-only — there is no way to change or remove an entry.
 *
 * Who did it is chosen by their Admin user ID, and the search box takes a
 * record's exact ID or an action code (docs/id-lookup.md). Names and emails
 * are shown on each entry but never searched.
 */
export function AdminAuditLogView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const list = useAdminResource(() => listAuditLog({ ...filters, page, pageSize }), [filters, page, pageSize]);
  const facets = useAdminResource(() => getAuditFacets(), []);
  const [openId, setOpenId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const data = list.data;
  const filtered = Object.values(filters).some(Boolean);

  const download = async () => {
    setExporting(true);
    try {
      await exportAuditLog(filters);
    } catch (error) {
      toast.error(problem(error, "The export didn't work."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="Audit log"
        description="Every change made in the portal, every sign-in and every refused request — recorded by the server, with what changed. Entries can't be edited or deleted; passwords and secrets are never stored."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Audit log" }]}
        actions={
          <div className="flex gap-2">
            <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
              {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
            </AdminButton>
            <AdminButton size="sm" onClick={() => void download()} loading={exporting}>
              {exporting ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Export CSV
            </AdminButton>
          </div>
        }
      />

      <StatusTabs label="Outcome" value={filters.outcome} onChange={(outcome) => setFilters({ outcome })}
        tabs={[{ value: "", label: "Everything" }, ...Object.entries(OUTCOME).map(([value, o]) => ({ value, label: o.label, count: data?.counts[value] }))]} />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <LogSearch label="Record ID or action" value={filters.q} onChange={(q) => setFilters({ q })}
          placeholder="A record's exact ID (PRD001) or an action (products.update)" />
        <FilterSelect label="Area" value={filters.resourceType} onChange={(resourceType) => setFilters({ resourceType })}
          options={[{ value: "", label: "Every area" }, ...(facets.data?.resourceTypes ?? []).map((r) => ({ value: r, label: r }))]} />
        <IdFilter entity="admin_user" label="Who (Admin user ID)" value={filters.actor}
          onChange={(actor) => setFilters({ actor })} className="w-52" />
        <div className="w-36"><AdminInput label="From" type="date" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })} /></div>
        <div className="w-36"><AdminInput label="To" type="date" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })} /></div>
        {filtered ? <AdminButton size="sm" variant="ghost" onClick={clear}><X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Clear</AdminButton> : null}
      </div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[60rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr><th className={TH}>When</th><th className={TH}>Who</th><th className={TH}>What</th><th className={TH}>Record</th><th className={TH}>Outcome</th><th className={TH}>From</th></tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={6} loading={list.isLoading && !data} failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)} onRetry={() => void list.reload()}
                title={filtered ? "Nothing matches" : "Nothing recorded yet"} hint={filtered ? "Try fewer filters." : "Changes made in the portal appear here."} />
              {data?.items.map((entry) => (
                <tr key={entry.id} className="cursor-pointer hover:bg-admin-raised" onClick={() => setOpenId(entry.id)}>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(entry.occurredAt)}</td>
                  <td className={TD}>
                    <span className="font-medium text-admin-ink">{entry.actor.name || (entry.actor.type === "anonymous" ? "Not signed in" : entry.actor.type)}</span>
                    {entry.actor.id ? <span className="block font-mono text-[0.625rem] text-admin-faint">{entry.actor.id}</span> : null}
                    {entry.actor.role ? <span className="block text-admin-muted">{entry.actor.role}</span> : null}
                  </td>
                  <td className={TD}>
                    <button type="button" className="text-left text-admin-ink hover:text-copper-700">{entry.summary || entry.action}</button>
                    <span className="block font-mono text-[0.625rem] text-admin-faint">{entry.action}{entry.hasChanges ? " · changes recorded" : ""}</span>
                  </td>
                  <td className={cn(TD, "text-admin-muted")}>{entry.resourceType}{entry.resourceId ? ` · ${entry.resourceId}` : ""}</td>
                  <td className={TD}><Badge tone={OUTCOME[entry.outcome]?.tone ?? "grey"}>{OUTCOME[entry.outcome]?.label ?? entry.outcome}</Badge></td>
                  <td className={cn(TD, "text-admin-muted")}>{entry.ipAddress || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
      {data ? <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
        totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} /> : null}

      <EntryDialog id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function EntryDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const entry = useAdminResource(() => getAuditEntry(id ?? 0), [id], { enabled: id !== null });
  const e: AuditEntry | null = entry.data;
  const changes = (e?.changes ?? {}) as Record<string, unknown>;
  return (
    <Modal open={id !== null} onOpenChange={(open) => !open && onClose()} title={e ? e.summary || e.action : "Audit entry"} className="max-w-2xl">
      {!e ? <p className="text-sm text-admin-muted">{entry.error ? problem(entry.error, "This didn't load.") : "Loading…"}</p> : (
        <div className="flex flex-col gap-4 text-xs">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="When">{formatDateTime(e.occurredAt)}</Detail>
            <Detail label="Outcome">{OUTCOME[e.outcome]?.label ?? e.outcome}{e.statusCode ? ` (${e.statusCode}${e.errorCode ? ` ${e.errorCode}` : ""})` : ""}</Detail>
            <Detail label="Who">{e.actor.name || e.actor.type}{e.actor.email ? ` · ${e.actor.email}` : ""}{e.actor.role ? ` · ${e.actor.role}` : ""}</Detail>
            <Detail label="Record">{e.resourceType}{e.resourceId ? ` · ${e.resourceId}` : ""}</Detail>
            <Detail label="Action"><span className="font-mono">{e.action}</span></Detail>
            <Detail label="Request">{e.requestId || "—"}</Detail>
            <Detail label="Address">{e.ipAddress || "—"}</Detail>
            <Detail label="Browser" wide>{e.userAgent || "—"}</Detail>
          </dl>
          {Object.keys(changes).length ? (
            <div>
              <p className="mb-1.5 font-medium text-admin-ink">What changed</p>
              <table className="w-full text-left">
                <thead className="text-admin-muted"><tr><th className="py-1 pr-3 font-medium">Field</th><th className="py-1 pr-3 font-medium">Before</th><th className="py-1 font-medium">After</th></tr></thead>
                <tbody className="divide-y divide-admin-border">
                  {Object.entries(changes).map(([field, change]) => {
                    const pair = change && typeof change === "object" && "from" in (change as object) ? (change as { from: unknown; to: unknown }) : { from: "—", to: change };
                    return (
                      <tr key={field} className="align-top">
                        <td className="py-1.5 pr-3 font-mono text-admin-ink">{field}</td>
                        <td className="py-1.5 pr-3 break-all text-admin-muted">{show(pair.from)}</td>
                        <td className="py-1.5 break-all text-admin-ink">{show(pair.to)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          {e.details ? <div><p className="mb-1.5 font-medium text-admin-ink">Details</p><JsonBlock value={e.details} /></div> : null}
        </div>
      )}
    </Modal>
  );
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
