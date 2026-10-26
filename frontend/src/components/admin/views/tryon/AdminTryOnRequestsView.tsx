"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { FilterSelect, LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Detail, JsonBlock, TD, TH, TableState, problem } from "@/components/admin/views/operations/shared";
import { CRUMBS, RequestBadge, TryOnTabs, seconds } from "@/components/admin/views/tryon/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { getRequest, listModels, listProviders, listRequests, requeueRequest } from "@/services/admin/tryOnAdminService";
import { toast } from "@/store/toastStore";

const KEYS = ["status", "q", "providerId", "modelId", "credentialId", "customerId", "planId", "capability", "errorCode", "from", "to"] as const;

const TABS = [
  { value: "", label: "All" },
  { value: "succeeded", label: "Success" },
  { value: "failed", label: "Failed" },
  { value: "processing", label: "Processing" },
  { value: "queued", label: "Queued" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
];

const ERRORS = [
  ["invalid_credentials", "Invalid credentials"], ["rate_limited", "Rate limited"], ["timeout", "Timed out"],
  ["provider_unavailable", "Provider unavailable"], ["no_capacity", "No capacity"], ["unsupported_category", "Unsupported category"],
  ["invalid_image", "Invalid image"], ["garment_unavailable", "Product image missing"], ["plan_ineligible", "Not eligible"],
  ["storage_unavailable", "Storage unavailable"], ["bad_provider_response", "Bad response"], ["unknown", "Unclassified"],
] as const;

/** Every try-on, filterable, with the plain-language reason for each failure. */
export function AdminTryOnRequestsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const list = useAdminResource(() => listRequests({ ...filters, page, pageSize }), [filters, page, pageSize]);
  const providers = useAdminResource(listProviders, []);
  const models = useAdminResource(listModels, []);
  const data = list.data;

  return (
    <div>
      <AdminPageHeader
        title="Try-on requests"
        description="Each request, what ran it and how it ended. Failures say why in plain language."
        breadcrumbs={[...CRUMBS, { label: "Requests" }]}
        actions={
          <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
            {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
          </AdminButton>
        }
      />
      <TryOnTabs />

      <StatusTabs label="Which requests" value={filters.status} onChange={(status) => setFilters({ status })}
        tabs={TABS.map((t) => ({ ...t, count: t.value ? data?.counts?.[t.value] : undefined }))} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch value={filters.q} onChange={(q) => setFilters({ q })} label="Find a request" placeholder="Request, customer or product ID (VTR001, CUS001, PRD001)" />
        <FilterSelect label="Provider" value={filters.providerId} onChange={(providerId) => setFilters({ providerId })}
          options={[{ value: "", label: "All providers" }, ...(providers.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
        <FilterSelect label="Model" value={filters.modelId} onChange={(modelId) => setFilters({ modelId })}
          options={[{ value: "", label: "All models" }, ...(models.data ?? []).map((m) => ({ value: m.id, label: m.name }))]} />
        <FilterSelect label="Failure" value={filters.errorCode} onChange={(errorCode) => setFilters({ errorCode })}
          options={[{ value: "", label: "Any reason" }, ...ERRORS.map(([value, label]) => ({ value, label }))]} />
        <input type="date" aria-label="From" value={filters.from} onChange={(e) => setFilters({ from: e.target.value })}
          className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink" />
        <input type="date" aria-label="To" value={filters.to} onChange={(e) => setFilters({ to: e.target.value })}
          className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink" />
        {Object.values(filters).some(Boolean) ? <AdminButton size="sm" variant="ghost" onClick={clear}>Clear</AdminButton> : null}
      </div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[62rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr><th className={TH}>Request</th><th className={TH}>Customer</th><th className={TH}>Product</th><th className={TH}>Status</th>
                <th className={TH}>Model · credential</th><th className={TH}>Plan</th><th className={TH}>When</th></tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={7} loading={list.isLoading && !data} failed={Boolean(list.error && !data)} empty={Boolean(data && !data.items.length)}
                onRetry={() => void list.reload()} title="No try-on requests" hint="Requests customers make appear here." />
              {data?.items.map((row) => (
                <tr key={row.id} className="align-top hover:bg-admin-raised">
                  <td className={TD}><Link href={`/admin/try-on/requests/detail?id=${row.id}`} className="font-medium text-admin-ink hover:text-copper-700">{row.id}</Link>
                    <span className="block text-admin-muted">{row.capabilityName}</span></td>
                  <td className={TD}><Link href={`/admin/customers/detail?id=${encodeURIComponent(row.customerId)}`} className="hover:text-copper-700">{row.customerId}</Link></td>
                  <td className={TD}>{row.productName}<span className="block text-admin-muted">{[row.productId, row.color, row.size].filter(Boolean).join(" · ")}</span></td>
                  <td className={TD}><RequestBadge status={row.status} badge={row.badge} />
                    {row.error ? <span className="mt-1 block max-w-[16rem] text-admin-muted">{row.error.explanation}</span> : null}</td>
                  <td className={TD}>{row.modelName || "—"}<span className="block text-admin-muted">{row.credentialLabel || "—"}{row.attempts > 1 ? ` · ${row.attempts} attempts` : ""}</span></td>
                  <td className={TD}>{row.planName}<span className="block text-admin-muted">{row.source}</span></td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.createdAt)}<span className="block">{seconds(row.durationMs)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
      {data ? <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
        totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} /> : null}
    </div>
  );
}

/** One request: who, what, which model and credential, every attempt, and the sanitised technical detail. */
export function AdminTryOnRequestDetailView() {
  const id = useSearchParams().get("id") ?? "";
  const request = useAdminResource(() => getRequest(id), [id], { enabled: Boolean(id) });
  const [busy, setBusy] = useState(false);
  const row = request.data;

  const requeue = async () => {
    setBusy(true);
    try {
      await requeueRequest(id);
      toast.success("Queued again — no extra charge to the customer.");
      void request.reload();
    } catch (error) {
      toast.error(problem(error, "It couldn't be queued again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <AdminPageHeader title={`Try-on ${id}`} breadcrumbs={[...CRUMBS, { label: "Requests", href: "/admin/try-on/requests" }, { label: id }]}
        actions={row?.status === "failed" && !row.deletedByCustomer ? (
          <AdminButton size="sm" variant="primary" onClick={() => void requeue()} loading={busy}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Run again
          </AdminButton>
        ) : null}
      />
      {request.error && !row ? (
        <AdminCard><p className="text-sm text-admin-ink">{problem(request.error, "This request didn't load.")}</p></AdminCard>
      ) : !row ? (
        <span className="block h-40 animate-pulse rounded-[3px] bg-admin-raised" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <AdminCard title="Outcome" className="lg:col-span-2">
            <div className="mb-3 flex items-center gap-2"><RequestBadge status={row.status} badge={row.badge} />
              {row.error?.retryable ? <span className="text-xs text-admin-muted">Can be retried</span> : null}</div>
            {row.error ? (
              <dl className="grid gap-3 text-xs sm:grid-cols-2">
                <Detail label="What happened">{row.error.explanation}</Detail>
                <Detail label="What the customer saw">{row.error.customerMessage}</Detail>
                <Detail label="Error code"><code>{row.error.code}</code></Detail>
                <Detail label="Technical detail (sanitised)" wide>{row.technicalDetail || "—"}</Detail>
              </dl>
            ) : (
              <p className="text-xs text-admin-muted">{row.technicalDetail || "No problems recorded."}</p>
            )}
          </AdminCard>
          <AdminCard title="Request">
            <dl className="grid gap-3 text-xs">
              <Detail label="Customer"><Link href={`/admin/customers/detail?id=${encodeURIComponent(row.customerId)}`} className="hover:text-copper-700">{row.customerId}</Link></Detail>
              <Detail label="Product">{row.productName} {row.productId ? `(${row.productId})` : ""}</Detail>
              <Detail label="Kind of item">{row.capabilityName}</Detail>
              <Detail label="Variant">{[row.color, row.size].filter(Boolean).join(" · ") || "—"}</Detail>
              <Detail label="Paid from">{row.planName} ({row.source}){row.allocationId ? ` · ${row.allocationId}` : ""}</Detail>
            </dl>
          </AdminCard>
          <AdminCard title="Routing and storage">
            <dl className="grid gap-3 text-xs">
              <Detail label="Provider">{row.providerName || "—"}</Detail>
              <Detail label="Model">{row.modelName || "—"}</Detail>
              <Detail label="Credential">{row.credentialLabel ? `${row.credentialLabel} (${row.credentialId})` : "—"}</Detail>
              <Detail label="Attempts">{row.attempts}{row.retriesUsed ? ` · ${row.retriesUsed} customer retries` : ""}</Detail>
              <Detail label="Storage">{row.storageMode}{row.resultStorage && row.resultStorage !== row.storageMode ? ` · in ${row.resultStorage}` : ""}</Detail>
              <Detail label="Result kept until">{row.resultDeletedAt ? `Deleted ${formatDateTime(row.resultDeletedAt)}` : row.resultExpiresAt ? formatDateTime(row.resultExpiresAt) : row.status === "succeeded" ? "Until the customer deletes it" : "—"}</Detail>
              {row.deletedByCustomer ? <Detail label="Customer">Deleted it</Detail> : null}
            </dl>
          </AdminCard>
          <AdminCard title="Timing">
            <dl className="grid gap-3 text-xs">
              <Detail label="Created">{formatDateTime(row.createdAt)}</Detail>
              <Detail label="Started">{formatDateTime(row.startedAt)}</Detail>
              <Detail label="Finished">{formatDateTime(row.finishedAt)}</Detail>
              <Detail label="Took">{seconds(row.durationMs)}</Detail>
              {row.feedbackRating ? <Detail label="Customer rating">{row.feedbackRating} / 5{row.feedbackComment ? ` — ${row.feedbackComment}` : ""}</Detail> : null}
            </dl>
          </AdminCard>
          <AdminCard title="Attempts" padded={false} className="lg:col-span-1">
            <table className="w-full text-left text-xs">
              <tbody className="divide-y divide-admin-border">
                {row.attemptLog?.length ? row.attemptLog.map((a) => (
                  <tr key={a.number} className="align-top">
                    <td className={TD}>#{a.number}<span className="block text-admin-muted">{a.credentialLabel || a.credentialId || "—"}</span></td>
                    <td className={TD}><RequestBadge status={a.outcome === "succeeded" ? "succeeded" : "failed"} badge={a.badge} />
                      {a.explanation ? <span className="mt-1 block text-admin-muted">{a.explanation}</span> : null}
                      {a.technicalDetail ? <span className="mt-1 block break-words text-admin-faint">{a.technicalDetail}</span> : null}</td>
                    <td className={cn(TD, "text-right text-admin-muted")}>{seconds(a.latencyMs)}</td>
                  </tr>
                )) : <tr><td className={TD}><span className="text-admin-muted">Not tried yet.</span></td></tr>}
              </tbody>
            </table>
          </AdminCard>
          <details className="lg:col-span-3"><summary className="cursor-pointer text-xs text-admin-muted">Raw record</summary>
            <JsonBlock value={{ ...row, attemptLog: undefined }} /></details>
        </div>
      )}
    </div>
  );
}
