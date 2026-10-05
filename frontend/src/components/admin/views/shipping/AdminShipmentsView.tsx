"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, ArrowRight, PackageCheck, RefreshCw, X } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { LogFooter, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState, problem } from "@/components/admin/views/operations/shared";
import { ActionDialog } from "@/components/admin/views/fulfilment/ActionDialog";
import { BulkLabelBar } from "@/components/admin/views/packing/BulkLabelBar";
import { LabelStatusBadge } from "@/components/admin/views/packing/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { getShipmentPipeline, listShipments, moveShipment } from "@/services/shippingService";
import { toast } from "@/store/toastStore";
import {
  SHIPMENT_STATUSES,
  SHIPMENT_STATUS_LABELS,
  type ShipmentPipeline,
  type ShipmentSummary,
  type ShipmentTransition,
} from "@/types/shipping";

import { ShipmentStatusBadge } from "./shared";

const KEYS = ["status", "q", "order", "provider", "from", "to"] as const;

const DATE_INPUT =
  "h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] text-admin-ink hover:border-admin-border-strong";

/**
 * Every shipment record, newest first. Only orders that finished packing and
 * had a shipment created appear here; packed orders still waiting for one
 * are listed above the table, never mixed into it (docs/order-fulfilment.md).
 * Found by ID — the Shipment ID (its number or
 * AWB) or the Order ID, never a name or email (docs/id-lookup.md) — and
 * filtered by status, courier provider (by code) and date, all kept in the
 * address bar so a filtered view can be shared.
 */
export function AdminShipmentsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const { status, q, order, provider, from, to } = filters;

  // Primitive dependencies: the filters object is rebuilt whenever the query string is read.
  const shipments = useAdminResource(
    () => listShipments({ status, q, order, provider, from, to, page, pageSize }),
    [status, q, order, provider, from, to, page, pageSize],
  );

  const pipeline = useAdminResource(() => getShipmentPipeline(), []);
  const [moving, setMoving] = useState<{ row: ShipmentSummary; move: ShipmentTransition } | null>(null);
  const [saving, setSaving] = useState(false);
  const [moveError, setMoveError] = useState("");

  const reloadAll = async () => {
    await Promise.all([shipments.reload(), pipeline.reload()]);
  };

  const confirmMove = async (reason: string) => {
    if (!moving) return;
    setSaving(true);
    setMoveError("");
    try {
      const updated = await moveShipment(moving.row.id, { status: moving.move.status, reason });
      toast.success(`${updated.shipmentNumber} is now ${updated.statusLabel.toLowerCase()}.`);
      setMoving(null);
    } catch (error) {
      setMoveError(problem(error, "The shipment wasn’t moved. Please try again."));
    } finally {
      setSaving(false);
      await reloadAll();
    }
  };

  const data = shipments.data;
  const counts = data?.counts ?? {};
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const filtered = Boolean(status || q || order || provider || from || to);
  const rangeInvalid = Boolean(from && to && from > to);
  // Picked rows for the label actions; kept across pages so a batch can span them.
  const [selected, setSelected] = useState<Record<number, string>>({});
  const selectedIds = Object.keys(selected).map(Number);
  const pageIds = data?.items.map((row) => row.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every((rowId) => rowId in selected);
  const toggle = (rowId: number, label: string) => setSelected((current) => {
    const next = { ...current };
    if (rowId in next) delete next[rowId];
    else next[rowId] = label;
    return next;
  });
  const togglePage = () => setSelected((current) => {
    const next = { ...current };
    for (const row of data?.items ?? []) {
      if (allOnPage) delete next[row.id];
      else next[row.id] = row.shipmentNumber;
    }
    return next;
  });

  return (
    <div>
      <AdminPageHeader
        title="Shipments"
        description="Every parcel handed to a courier: where it is, and anything that needs a hand."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Shipments" }]}
        actions={
          <>
            <AdminButtonLink href="/admin/settings/couriers" size="sm" variant="ghost">
              Courier settings
            </AdminButtonLink>
            <AdminButton size="sm" onClick={() => void reloadAll()} loading={shipments.isRefreshing}>
              {shipments.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Refresh
            </AdminButton>
          </>
        }
      />

      <PipelineBanner pipeline={pipeline.data} />

      <StatusTabs
        label="Filter shipments by status"
        value={status}
        onChange={(next) => setFilters({ status: next })}
        tabs={[
          { value: "", label: "All", count: data?.counts ? total : undefined },
          ...SHIPMENT_STATUSES.map((value) => ({
            value,
            label: SHIPMENT_STATUS_LABELS[value],
            count: data?.counts ? (counts[value] ?? 0) : undefined,
          })),
        ]}
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <IdFilter entity="shipment" label="Shipment ID or AWB" value={q} onChange={(next) => setFilters({ q: next })} className="w-64" />
        <IdFilter entity="order" value={order} onChange={(next) => setFilters({ order: next })} className="w-52" />
        <IdFilter entity="courier" label="Courier code" value={provider} onChange={(next) => setFilters({ provider: next })}
          className="w-48" />
        <label className="flex items-center gap-1.5 text-xs text-admin-muted">
          From
          <input type="date" aria-label="Created from" value={from} max={to || undefined} onChange={(event) => setFilters({ from: event.target.value })} className={DATE_INPUT} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-admin-muted">
          To
          <input type="date" aria-label="Created to" value={to} min={from || undefined} onChange={(event) => setFilters({ to: event.target.value })} className={DATE_INPUT} />
        </label>
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>
      {rangeInvalid ? (
        <p role="alert" className="mb-3 text-xs text-[#a12b2b]">
          The start date is after the end date, so nothing can match.
        </p>
      ) : null}

      <BulkLabelBar selected={selectedIds} labels={selected} onClear={() => setSelected({})}
        onDone={() => void shipments.reload()} />

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[66rem] text-left text-xs", shipments.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={cn(TH, "w-8")}>
                  <input type="checkbox" aria-label="Select every shipment on this page" checked={allOnPage}
                    disabled={pageIds.length === 0} onChange={togglePage} />
                </th>
                <th className={TH}>Shipment</th>
                <th className={TH}>Order</th>
                <th className={TH}>Customer</th>
                <th className={TH}>Courier</th>
                <th className={TH}>AWB</th>
                <th className={TH}>Status</th>
                <th className={TH}>Label</th>
                <th className={TH}>Expected</th>
                <th className={TH}>Created</th>
                <th className={cn(TH, "text-right")}>Next step</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={11}
                loading={shipments.isLoading && !data}
                failed={Boolean(shipments.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void shipments.reload()}
                title={filtered ? "No shipments match" : "No shipments yet"}
                hint={
                  filtered
                    ? "Try a different filter or search."
                    : pipeline.data && pipeline.data.readyToShip.count > 0
                      ? `${pipeline.data.readyToShip.count} packed ${pipeline.data.readyToShip.count === 1 ? "order is" : "orders are"} ready — create ${pipeline.data.readyToShip.count === 1 ? "its shipment" : "their shipments"} from the list above.`
                      : "A shipment is created from an order's page once the order is packed."
                }
              />
              {data?.items.map((row) => (
                <tr key={row.id} className="align-top hover:bg-admin-raised">
                  <td className={TD}>
                    <input type="checkbox" aria-label={`Select ${row.shipmentNumber}`} checked={row.id in selected}
                      onChange={() => toggle(row.id, row.shipmentNumber)} />
                  </td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <Link
                      href={`/admin/shipments/detail?id=${encodeURIComponent(String(row.id))}`}
                      className="font-medium text-admin-ink hover:text-copper-700"
                    >
                      {row.shipmentNumber}
                    </Link>
                  </td>
                  <td className={cn(TD, "whitespace-nowrap")}>
                    <Link href={`/admin/orders/detail?id=${encodeURIComponent(row.orderId)}`} className="text-admin-muted hover:text-copper-700">
                      #{row.orderNumber}
                    </Link>
                  </td>
                  <td className={cn(TD, "text-admin-ink")}>{row.customerName || "—"}</td>
                  <td className={cn(TD, "text-admin-ink")}>{row.courierName || "—"}</td>
                  <td className={cn(TD, "font-mono text-[0.6875rem] text-admin-muted")}>{row.awb || "—"}</td>
                  <td className={TD}>
                    <span className="flex flex-col items-start gap-1">
                      <ShipmentStatusBadge status={row.status} label={row.statusLabel} />
                      {row.requestStatus === "failed" ? (
                        <span className="inline-flex max-w-[14rem] items-start gap-1 text-[0.625rem] text-[#a12b2b]" title={row.lastError}>
                          <AlertTriangle className="mt-px h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                          <span className="line-clamp-2">Courier request failed{row.lastError ? `: ${row.lastError}` : ""}</span>
                        </span>
                      ) : row.requestStatus === "pending" ? (
                        <span className="text-[0.625rem] text-admin-muted">Waiting for the courier</span>
                      ) : null}
                    </span>
                  </td>
                  <td className={TD}>{row.labelStatus ? <LabelStatusBadge status={row.labelStatus} /> : null}</td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>
                    {row.expectedDeliveryAt ? formatDate(row.expectedDeliveryAt) : "—"}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDate(row.createdAt)}</td>
                  <td className={cn(TD, "whitespace-nowrap text-right")}>
                    {row.nextAction ? (
                      <AdminButton size="sm" variant="secondary"
                        onClick={() => { setMoveError(""); setMoving({ row, move: row.nextAction as ShipmentTransition }); }}>
                        {row.nextAction.action}
                      </AdminButton>
                    ) : row.exception ? (
                      <Link href={`/admin/shipments/detail?id=${row.id}`} className="text-[0.6875rem] font-medium text-[#8a5d00] hover:text-admin-ink">
                        Needs a decision
                      </Link>
                    ) : (
                      <span className="text-[0.6875rem] text-admin-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {moving ? (
      <ActionDialog
        open
        title={moving ? `${moving.move.action}?` : ""}
        description={moving ? `${moving.row.shipmentNumber} (order #${moving.row.orderNumber}) moves to ${moving.move.label.toLowerCase()}. The order follows, and the customer may be notified.` : ""}
        confirmLabel={moving?.move.action ?? "Confirm"}
        destructive={moving ? moving.move.kind !== "forward" : false}
        requiresReason={Boolean(moving?.move.requiresReason)}
        saving={saving}
        error={moveError}
        onCancel={() => setMoving(null)}
        onConfirm={(reason) => void confirmMove(reason)}
      />
      ) : null}

      {data ? (
        <LogFooter
          page={data.pagination.page}
          pageSize={pageSize}
          total={data.pagination.total}
          totalPages={data.pagination.total_pages}
          onPage={setPage}
          onPageSize={setPageSize}
        />
      ) : null}
    </div>
  );
}

/**
 * Above the list: packed orders waiting for a shipment (they are not
 * shipments yet, so they are never rows of the table), orders dispatched
 * with no shipment on record, and whether a courier is switched on.
 */
function PipelineBanner({ pipeline }: { pipeline: ShipmentPipeline | null }) {
  if (!pipeline) return null;
  const { readyToShip, missingShipments, couriersActive, deliveredWithoutShipment } = pipeline;
  if (!readyToShip.count && !missingShipments.count && couriersActive && !deliveredWithoutShipment) return null;

  return (
    <div className="mb-4 flex flex-col gap-3">
      {!couriersActive ? (
        <p role="alert" className="flex items-start gap-2 rounded-[3px] bg-[#fdeee7] px-3 py-2.5 text-xs text-[#9c4a24]">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span>
            No courier is switched on, so no shipment can be created yet.{" "}
            <Link href="/admin/settings/couriers" className="font-medium underline">
              Set one up in Courier settings
            </Link>{" "}
            — the Manual courier works without any integration.
          </span>
        </p>
      ) : null}

      {readyToShip.count > 0 ? (
        <AdminCard padded>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-admin-ink">
              <PackageCheck className="h-4 w-4 text-[#0a6b0a]" strokeWidth={1.75} aria-hidden="true" />
              {readyToShip.count} {readyToShip.count === 1 ? "order" : "orders"} ready to create shipment
            </p>
            <Link href="/admin/packing?status=packed" className="text-xs font-medium text-copper-700 hover:text-admin-ink">
              See all in Packing
            </Link>
          </div>
          <ul className="mt-2 divide-y divide-admin-border text-xs">
            {readyToShip.items.slice(0, 5).map((item) => (
              <li key={item.orderId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-admin-ink">#{item.orderNumber}</span>{" "}
                  <span className="text-admin-muted">
                    {item.customerName} · {item.packageCount} package{item.packageCount === 1 ? "" : "s"}
                    {item.packedAt ? ` · packed ${formatDate(item.packedAt)}` : ""}
                    {item.paymentStatus === "cod-pending" ? " · COD" : ""}
                  </span>
                </span>
                <AdminButtonLink href={`/admin/orders/detail?id=${encodeURIComponent(item.orderId)}`} size="sm" variant="secondary">
                  Create shipment
                  <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                </AdminButtonLink>
              </li>
            ))}
          </ul>
        </AdminCard>
      ) : null}

      {missingShipments.count > 0 ? (
        <div className="rounded-[3px] border border-[#fab219]/40 bg-[#fdf3dd] px-3 py-2.5 text-xs text-[#8a5d00]">
          <p className="font-medium">
            {missingShipments.count} {missingShipments.count === 1 ? "order was" : "orders were"} marked dispatched without a shipment record
          </p>
          <p className="mt-0.5 leading-relaxed">
            Moved by hand before shipments were required. Open each to record the shipment (courier and AWB) that carried it — nothing is filled in for you.
          </p>
          <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {missingShipments.items.map((item) => (
              <Link key={item.orderId} href={`/admin/orders/detail?id=${encodeURIComponent(item.orderId)}`} className="font-medium underline">
                #{item.orderNumber} ({item.statusLabel.toLowerCase()})
              </Link>
            ))}
            {missingShipments.count > missingShipments.items.length ? <span>and {missingShipments.count - missingShipments.items.length} more</span> : null}
          </p>
        </div>
      ) : null}

      {deliveredWithoutShipment > 0 ? (
        <p className="text-[0.6875rem] text-admin-muted">
          {deliveredWithoutShipment} delivered {deliveredWithoutShipment === 1 ? "order has" : "orders have"} no shipment record
          (completed before shipments were tracked). They stay as they are.
        </p>
      ) : null}
    </div>
  );
}
