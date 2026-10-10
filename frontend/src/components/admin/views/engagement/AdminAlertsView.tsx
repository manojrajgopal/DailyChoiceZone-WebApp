"use client";

import Link from "next/link";
import { useState } from "react";
import { Download, RefreshCw, Send, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { LogFooter, StatusTabs, collectPages, downloadCsv, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Badge, TD, TH, TableState, problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";
import { listAlerts, listWaiting, resendAlert, type AdminAlertRow } from "@/services/admin/engagementAdminService";
import { toast } from "@/store/toastStore";

const KEYS = ["view", "kind", "status", "productId", "customerId"] as const;

type UrlFilters = ReturnType<typeof useUrlFilters<(typeof KEYS)[number]>>;

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  active: { label: "Waiting", tone: "amber" },
  notified: { label: "Notified", tone: "green" },
  unsubscribed: { label: "Unsubscribed", tone: "grey" },
};

const TABS = [
  ["waiting", "Waiting customers"],
  ["stock", "Back in stock"],
  ["price", "Price drops"],
] as const;

/**
 * Who is waiting for what. The first tab counts the customers waiting for each
 * out-of-stock product — what to restock first, and for how many people; the
 * others list every back-in-stock and price-drop alert with the customer's
 * details. An alert that couldn't be emailed shows why, and can be sent again
 * once the reason is fixed; one that was sent but bounced shows the email
 * log's failure.
 */
export function AdminAlertsView() {
  const url = useUrlFilters(KEYS);
  const { filters, setFilters } = url;
  const tab = filters.view === "list" || filters.kind || filters.status || filters.customerId
    ? (filters.kind === "price" ? "price" : "stock")
    : "waiting";

  return (
    <div>
      <AdminPageHeader
        title="Stock & price alerts"
        description="Customers waiting for a product to come back, or for its price to drop. Each alert emails once."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Stock & price alerts" }]}
      />

      <div className="mb-4 inline-flex rounded-[3px] border border-admin-border bg-admin-surface p-0.5" role="tablist" aria-label="Alert type">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setFilters(value === "waiting"
              ? { view: "", kind: "", status: "", customerId: "" }
              : { view: "list", kind: value === "price" ? "price" : "", status: "" })}
            className={cn("rounded-[2px] px-3.5 py-1.5 text-xs font-medium", tab === value ? "bg-admin-ink text-white" : "text-admin-muted hover:text-admin-ink")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "waiting" ? <WaitingByProduct url={url} /> : <AlertList url={url} kind={tab} />}
    </div>
  );
}

function variantLabel(size?: string, color?: string): string {
  return [size, color].filter(Boolean).join(" · ") || "Any";
}

/** Out-of-stock products customers asked about, most wanted first. */
function WaitingByProduct({ url }: { url: UrlFilters }) {
  const { filters, page, pageSize, setFilters, setPage, setPageSize } = url;
  const [exporting, setExporting] = useState(false);
  const rows = useAdminResource(
    () => listWaiting({ productId: filters.productId, page, pageSize }),
    [filters.productId, page, pageSize],
  );
  const data = rows.data;

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { rows: all, truncated } = await collectPages((p) => listWaiting({ productId: filters.productId, page: p, pageSize: 100 }));
      downloadCsv(
        `waiting-customers-${new Date().toISOString().slice(0, 10)}.csv`,
        ["Product ID", "SKU", "Product", "Variant", "Customers waiting", "In stock", "First asked", "Last asked"],
        all.map((row) => [
          row.productId, row.product?.sku ?? "", row.product?.name ?? "", variantLabel(row.size, row.color), row.waiting,
          row.product?.stock ?? 0, formatDateTime(row.oldest), formatDateTime(row.newest),
        ]),
      );
      toast.success(truncated ? `Exported the first ${all.length} products.` : `Exported ${all.length} products.`);
    } catch (error) {
      toast.error(problem(error, "The export didn't work."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      {data ? (
        <div className="mb-3 flex flex-wrap gap-2" aria-label="Waiting totals">
          <Badge tone="amber">{data.summary.customers} customer{data.summary.customers === 1 ? "" : "s"} waiting</Badge>
          <Badge tone="grey">{data.summary.products} product{data.summary.products === 1 ? "" : "s"}</Badge>
          <Badge tone="grey">{data.summary.requests} request{data.summary.requests === 1 ? "" : "s"}</Badge>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <IdFilter entity="product" label="Product ID or SKU" value={filters.productId} onChange={(productId) => setFilters({ productId })} className="w-56" />
        {filters.productId ? (
          <AdminButton size="sm" variant="ghost" onClick={() => setFilters({ productId: "" })}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
        <Actions refreshing={rows.isRefreshing} onRefresh={() => void rows.reload()} exporting={exporting}
          onExport={() => void exportCsv()} canExport={Boolean(data && data.pagination.total > 0)} />
      </div>

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[48rem] text-left text-xs", rows.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Product</th>
                <th className={TH}>Variant</th>
                <th className={cn(TH, "text-right")}>Waiting</th>
                <th className={cn(TH, "text-right")}>In stock</th>
                <th className={TH}>First asked</th>
                <th className={TH}>Last asked</th>
                <th className={cn(TH, "text-right")}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={7}
                loading={rows.isLoading && !data}
                failed={Boolean(rows.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void rows.reload()}
                title={filters.productId ? "Nobody is waiting for that product" : "Nobody is waiting"}
                hint="When a customer taps Notify me on an out-of-stock product, it shows here."
              />
              {data?.items.map((row) => (
                <tr key={`${row.productId}-${row.size}-${row.color}`} className="align-top hover:bg-admin-raised">
                  <td className={TD}>
                    <Link href={`/admin/products/edit?id=${encodeURIComponent(row.productId)}`} className="block font-medium text-admin-ink hover:text-copper-700">
                      {row.product?.name ?? row.productId}
                    </Link>
                    <span className="block font-mono text-[0.6875rem] text-admin-muted">{row.product?.sku || row.productId}</span>
                  </td>
                  <td className={cn(TD, "text-admin-muted")}>{variantLabel(row.size, row.color)}</td>
                  <td className={cn(TD, "text-right text-sm font-semibold text-admin-ink")}>{row.waiting}</td>
                  <td className={cn(TD, "text-right")}>
                    {row.product && row.product.stock > 0
                      ? <Badge tone="green">{row.product.stock} in stock</Badge>
                      : <Badge tone="red">Out of stock</Badge>}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.oldest)}</td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.newest)}</td>
                  <td className={cn(TD, "text-right")}>
                    <AdminButton size="sm" variant="ghost"
                      aria-label={`See the customers waiting for ${row.product?.name ?? row.productId}`}
                      onClick={() => setFilters({ view: "list", kind: "", status: "active", productId: row.productId })}>
                      See customers
                    </AdminButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {data ? (
        <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
          totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} />
      ) : null}
    </>
  );
}

/** Every alert, one row each, with the customer's details. */
function AlertList({ url, kind }: { url: UrlFilters; kind: "stock" | "price" }) {
  const { filters, page, pageSize, setFilters, setPage, setPageSize } = url;
  const [busy, setBusy] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  // Alerts are found by exact IDs — never a customer's name or email, or a product's name.
  const ids = { productId: filters.productId, customerId: filters.customerId };
  const alerts = useAdminResource(
    () => listAlerts(kind, { status: filters.status, ...ids, page, pageSize }),
    [kind, filters.status, filters.productId, filters.customerId, page, pageSize],
  );
  const data = alerts.data;
  const counts = data?.counts ?? {};
  const filtered = Boolean(filters.status || filters.productId || filters.customerId);

  const resend = async (row: AdminAlertRow) => {
    setBusy(row.id);
    try {
      const result = await resendAlert(kind, row.id);
      toast.success(result.outcome === "sent" ? "Alert sent." : "Queued for the next check.");
      await alerts.reload();
    } catch (error) {
      toast.error(problem(error, "The alert couldn't be sent."));
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { rows, truncated } = await collectPages((p) =>
        listAlerts(kind, { status: filters.status, ...ids, page: p, pageSize: 100 }),
      );
      downloadCsv(
        `${kind}-alerts-${new Date().toISOString().slice(0, 10)}.csv`,
        ["Customer ID", "Customer", "Email", "Phone", "Product ID", "SKU", "Product",
          kind === "stock" ? "Variant" : "Trigger", "Status", "Created", "Notified", "Attempts", "Last problem"],
        rows.map((row) => [
          row.customer?.id ?? "", row.customer?.name ?? "", row.customer?.email ?? "", row.customer?.phone ?? "",
          row.product?.id ?? "", row.product?.sku ?? "", row.product?.name ?? "",
          kind === "stock" ? [row.size, row.color].filter(Boolean).join(" / ") : trigger(row),
          STATUS[row.status]?.label ?? row.status, formatDateTime(row.createdAt),
          row.notifiedAt ? formatDateTime(row.notifiedAt) : "", row.attempts, row.lastError,
        ]),
      );
      toast.success(truncated ? `Exported the newest ${rows.length} alerts.` : `Exported ${rows.length} alerts.`);
    } catch (error) {
      toast.error(problem(error, "The export didn't work."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <StatusTabs
        label="Filter alerts by status"
        value={filters.status}
        onChange={(status) => setFilters({ view: "list", status })}
        tabs={[
          { value: "", label: "All" },
          { value: "active", label: "Waiting", count: counts.active },
          { value: "notified", label: "Notified", count: counts.notified },
          { value: "unsubscribed", label: "Unsubscribed", count: counts.unsubscribed },
          { value: "failing", label: "Couldn't send" },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <IdFilter entity="customer" value={filters.customerId} onChange={(customerId) => setFilters({ view: "list", customerId })} className="w-56" />
        <IdFilter entity="product" label="Product ID or SKU" value={filters.productId} onChange={(productId) => setFilters({ view: "list", productId })} className="w-56" />
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={() => setFilters({ view: "list", status: "", productId: "", customerId: "" })}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
        <Actions refreshing={alerts.isRefreshing} onRefresh={() => void alerts.reload()} exporting={exporting}
          onExport={() => void exportCsv()} canExport={Boolean(data && data.pagination.total > 0)} />
      </div>

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[60rem] text-left text-xs", alerts.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Customer</th>
                <th className={TH}>Product</th>
                <th className={TH}>{kind === "stock" ? "Variant" : "Trigger"}</th>
                <th className={TH}>Status</th>
                <th className={TH}>Created</th>
                <th className={TH}>Notified</th>
                <th className={TH}>Email</th>
                <th className={cn(TH, "text-right")}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={8}
                loading={alerts.isLoading && !data}
                failed={Boolean(alerts.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void alerts.reload()}
                title={filtered ? "No alerts match" : "No alerts yet"}
                hint={filtered ? "Try a different filter or search." : "Alerts appear when customers ask to be told about a product."}
              />
              {data?.items.map((row) => {
                const status = STATUS[row.status] ?? STATUS.active!;
                return (
                  <tr key={row.id} className="align-top hover:bg-admin-raised">
                    <td className={TD}>
                      {row.customer ? (
                        <>
                          <Link href={`/admin/customers/detail?id=${encodeURIComponent(row.customer.id)}`} className="block font-medium text-admin-ink hover:text-copper-700">
                            {row.customer.name}
                          </Link>
                          <span className="block text-admin-muted">{row.customer.email}</span>
                          {row.customer.phone ? <span className="block text-admin-muted">{row.customer.phone}</span> : null}
                        </>
                      ) : "—"}
                    </td>
                    <td className={TD}>
                      {row.product ? (
                        <>
                          <span className="block text-admin-ink">{row.product.name}</span>
                          <span className="block text-admin-muted">
                            {formatPrice(row.product.price)} · {row.product.available ? "In stock" : "Out of stock"}
                          </span>
                        </>
                      ) : "—"}
                    </td>
                    <td className={cn(TD, "text-admin-muted")}>
                      {kind === "stock" ? [row.size, row.color].filter(Boolean).join(" · ") || "Any" : trigger(row)}
                    </td>
                    <td className={TD}><Badge tone={status.tone}>{status.label}</Badge></td>
                    <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.createdAt)}</td>
                    <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>
                      {row.notifiedAt ? formatDateTime(row.notifiedAt) : "—"}
                      {row.notifiedPrice ? <span className="block">at {formatPrice(row.notifiedPrice)}</span> : null}
                    </td>
                    <td className={cn(TD, "max-w-[16rem]")}>
                      {row.lastError ? (
                        <span className="text-[#a12b2b]">{row.lastError}</span>
                      ) : row.delivery ? (
                        <span className={row.delivery.status === "failed" ? "text-[#a12b2b]" : "text-admin-muted"}>
                          {row.delivery.status === "failed" ? `Failed: ${row.delivery.error}` : `Sent ${formatDateTime(row.delivery.at)}`}
                        </span>
                      ) : (
                        <span className="text-admin-faint">{row.attempts ? `${row.attempts} attempt(s)` : "—"}</span>
                      )}
                      {row.history && row.history.length > 0 ? (
                        <span className="mt-1 block text-admin-faint">
                          {row.history.map((h) => `${formatPrice(h.fromPrice)} → ${formatPrice(h.toPrice)}`).join(", ")}
                        </span>
                      ) : null}
                    </td>
                    <td className={cn(TD, "text-right")}>
                      {row.status !== "unsubscribed" && (row.lastError || row.delivery?.status === "failed" || row.status === "notified") ? (
                        <AdminButton size="sm" variant="ghost" onClick={() => void resend(row)} loading={busy === row.id}
                          aria-label={`Send the alert to ${row.customer?.email ?? "the customer"} again`}>
                          {busy === row.id ? null : <Send className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
                          Resend
                        </AdminButton>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {data ? (
        <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
          totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} />
      ) : null}
    </>
  );
}

function Actions({ refreshing, onRefresh, exporting, onExport, canExport }: {
  refreshing: boolean; onRefresh: () => void; exporting: boolean; onExport: () => void; canExport: boolean;
}) {
  return (
    <div className="ml-auto flex gap-2">
      <AdminButton size="sm" onClick={onRefresh} loading={refreshing}>
        {refreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
        Refresh
      </AdminButton>
      <AdminButton size="sm" onClick={onExport} loading={exporting} disabled={!canExport}>
        {exporting ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
        Export CSV
      </AdminButton>
    </div>
  );
}

function trigger(row: AdminAlertRow): string {
  return row.mode === "target" && row.targetPrice
    ? `At or below ${formatPrice(row.targetPrice)}`
    : `Any drop below ${formatPrice(row.baselinePrice ?? 0)}`;
}
