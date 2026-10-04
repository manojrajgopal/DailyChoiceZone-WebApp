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
import { listAlerts, resendAlert, type AdminAlertRow } from "@/services/admin/engagementAdminService";
import { toast } from "@/store/toastStore";

const KEYS = ["kind", "status", "productId", "customerId"] as const;

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  active: { label: "Waiting", tone: "amber" },
  notified: { label: "Notified", tone: "green" },
  unsubscribed: { label: "Unsubscribed", tone: "grey" },
};

/**
 * Who is waiting for what: back-in-stock and price-drop alerts. An alert that
 * couldn't be emailed shows why, and can be sent again once the reason is
 * fixed; one that was sent but bounced shows the email log's failure.
 */
export function AdminAlertsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const kind = filters.kind === "price" ? "price" : "stock";
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
        ["Customer", "Email", "Product", kind === "stock" ? "Variant" : "Trigger", "Status", "Created", "Notified", "Attempts", "Last problem"],
        rows.map((row) => [
          row.customer?.name ?? "", row.customer?.email ?? "", row.product?.name ?? "",
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
    <div>
      <AdminPageHeader
        title="Stock & price alerts"
        description="Customers waiting for a product to come back, or for its price to drop. Each alert emails once."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Stock & price alerts" }]}
        actions={
          <>
            <AdminButton size="sm" onClick={() => void alerts.reload()} loading={alerts.isRefreshing}>
              {alerts.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Refresh
            </AdminButton>
            <AdminButton size="sm" onClick={() => void exportCsv()} loading={exporting} disabled={!data || data.pagination.total === 0}>
              {exporting ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Export CSV
            </AdminButton>
          </>
        }
      />

      <div className="mb-4 inline-flex rounded-[3px] border border-admin-border bg-admin-surface p-0.5" role="tablist" aria-label="Alert type">
        {(["stock", "price"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            onClick={() => setFilters({ kind: value === "stock" ? "" : value, status: "" })}
            className={cn("rounded-[2px] px-3.5 py-1.5 text-xs font-medium", kind === value ? "bg-admin-ink text-white" : "text-admin-muted hover:text-admin-ink")}
          >
            {value === "stock" ? "Back in stock" : "Price drops"}
          </button>
        ))}
      </div>

      <StatusTabs
        label="Filter alerts by status"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "All" },
          { value: "active", label: "Waiting", count: counts.active },
          { value: "notified", label: "Notified", count: counts.notified },
          { value: "unsubscribed", label: "Unsubscribed", count: counts.unsubscribed },
          { value: "failing", label: "Couldn't send" },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <IdFilter entity="customer" value={filters.customerId} onChange={(customerId) => setFilters({ customerId })} className="w-56" />
        <IdFilter entity="product" label="Product ID or SKU" value={filters.productId} onChange={(productId) => setFilters({ productId })} className="w-56" />
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
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
    </div>
  );
}

function trigger(row: AdminAlertRow): string {
  return row.mode === "target" && row.targetPrice
    ? `At or below ${formatPrice(row.targetPrice)}`
    : `Any drop below ${formatPrice(row.baselinePrice ?? 0)}`;
}
