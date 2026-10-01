"use client";

import { useState } from "react";
import { RefreshCw, RotateCcw, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { FilterSelect, LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatAgo, formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import {
  getWebhookEvent,
  listWebhookEvents,
  replayWebhookEvent,
  webhookMetrics,
  type WebhookEventRow,
  type WebhookStatus,
} from "@/services/admin/operationsAdminService";
import { toast } from "@/store/toastStore";

import { Badge, Detail, JsonBlock, TD, TH, TableState, Tile, problem } from "./shared";

const KEYS = ["status", "event", "q", "days"] as const;

const STATUS: Record<WebhookStatus, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  processed: { label: "Processed", tone: "green" },
  ignored: { label: "Ignored", tone: "grey" },
  failed: { label: "Failed", tone: "red" },
  processing: { label: "Processing", tone: "amber" },
  retrying: { label: "Retrying", tone: "amber" },
};

const TRIGGER: Record<string, string> = {
  delivery: "Delivered by Razorpay",
  redelivery: "Redelivered by Razorpay",
  replay: "Replayed from the portal",
};

/**
 * Every Razorpay webhook event: what it was, what processing concluded, and
 * — for one that failed — the error and a replay. A replay runs the same
 * idempotent settlement as a delivery, so a payment can't be settled twice.
 */
export function AdminWebhooksView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [replaying, setReplaying] = useState<WebhookEventRow | null>(null);
  const [busy, setBusy] = useState(false);

  const days = filters.days || "7";
  const metrics = useAdminResource(() => webhookMetrics(days), [days]);
  const events = useAdminResource(
    () => listWebhookEvents({ status: filters.status, event: filters.event, q: filters.q, days: filters.days, page, pageSize }),
    [filters, page, pageSize],
  );
  const detail = useAdminResource(() => getWebhookEvent(openId ?? ""), [openId], { enabled: openId !== null });
  const m = metrics.data;
  const data = events.data;
  const filtered = Boolean(filters.status || filters.event || filters.q || filters.days);

  const reload = async () => {
    await Promise.all([metrics.reload(), events.reload(), openId ? detail.reload() : Promise.resolve()]);
  };

  const replay = async () => {
    if (!replaying) return;
    setBusy(true);
    try {
      const result = await replayWebhookEvent(replaying.eventId);
      if (result.outcome.failed) toast.error(`Replayed, but processing failed again: ${result.outcome.error ?? "see the event"}`);
      else toast.success("Replayed and processed.");
      setReplaying(null);
      await reload();
    } catch (error) {
      toast.error(problem(error, "The replay didn't run. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="Payment webhooks"
        description="Every event Razorpay sent: processed, ignored or failed, with retries and duplicates. Failed events can be replayed safely."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Billing", href: "/admin/billing" }, { label: "Payment webhooks" }]}
        actions={
          <AdminButton size="sm" onClick={() => void reload()} loading={events.isRefreshing}>
            {events.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Refresh
          </AdminButton>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label={`Events · ${days} days`} value={m ? m.total.toLocaleString("en-IN") : null} />
        <Tile label="Processed" value={m ? m.processed.toLocaleString("en-IN") : null} tone="good" />
        <Tile label="Failed" value={m ? m.failed.toLocaleString("en-IN") : null} tone={m?.failed ? "bad" : undefined} />
        <Tile label="Failing now" value={m ? m.failingNow.toLocaleString("en-IN") : null} tone={m?.failingNow ? "bad" : undefined} hint="Across all time" />
        <Tile label="Duplicates" value={m ? m.duplicates.toLocaleString("en-IN") : null} hint="Acknowledged, not applied" />
        <Tile
          label="Success rate"
          value={m ? (m.successRate === null ? "—" : `${m.successRate}%`) : null}
          hint={m?.lastReceivedAt ? `Last event ${formatAgo(m.lastReceivedAt)}` : m ? "No events yet" : undefined}
        />
      </div>

      <StatusTabs
        label="Filter events by status"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "All" },
          { value: "failed", label: "Failed" },
          { value: "processed", label: "Processed" },
          { value: "ignored", label: "Ignored" },
          { value: "retrying", label: "Retrying" },
          { value: "duplicates", label: "Had duplicates" },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch label="Search events" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Event, payment, Razorpay payment, refund ID or order number" />
        <FilterSelect
          label="Event type"
          value={filters.event}
          onChange={(event) => setFilters({ event })}
          options={[{ value: "", label: "All event types" }, ...(data?.events ?? []).map((event) => ({ value: event, label: event }))]}
        />
        <FilterSelect
          label="Received"
          value={filters.days}
          onChange={(value) => setFilters({ days: value })}
          options={[
            { value: "", label: "Any time" },
            { value: "1", label: "Last 24 hours" },
            { value: "7", label: "Last 7 days" },
            { value: "30", label: "Last 30 days" },
          ]}
        />
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[60rem] text-left text-xs", events.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Received</th>
                <th className={TH}>Event</th>
                <th className={TH}>Status</th>
                <th className={TH}>Payment</th>
                <th className={cn(TH, "text-right")}>Attempts</th>
                <th className={cn(TH, "text-right")}>Duplicates</th>
                <th className={TH}>Result</th>
                <th className={cn(TH, "text-right")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={8}
                loading={events.isLoading && !data}
                failed={Boolean(events.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void events.reload()}
                title={filtered ? "No events match" : "No webhook events yet"}
                hint={filtered ? "Try a different filter or search." : "Events appear here as Razorpay sends them."}
              />
              {data?.items.map((row) => {
                const status = STATUS[row.status] ?? STATUS.processing;
                return (
                  <tr key={row.eventId} className="align-top hover:bg-admin-raised">
                    <td className={cn(TD, "whitespace-nowrap")}>
                      <span className="block text-admin-ink">{formatDateTime(row.receivedAt)}</span>
                      <span className="block max-w-[11rem] truncate text-[0.625rem] text-admin-faint" title={row.eventId}>
                        {row.eventId}
                      </span>
                    </td>
                    <td className={cn(TD, "font-medium text-admin-ink")}>{row.event}</td>
                    <td className={TD}>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td className={TD}>
                      <span className="block text-admin-ink">{row.paymentId ?? "—"}</span>
                      <span className="block text-[0.625rem] text-admin-faint">{row.gatewayPaymentId ?? row.refundId ?? ""}</span>
                    </td>
                    <td className={cn(TD, "text-right tabular-nums")}>{row.attempts}</td>
                    <td className={cn(TD, "text-right tabular-nums")}>{row.duplicates}</td>
                    <td className={cn(TD, "max-w-[16rem]")}>
                      {row.status === "failed" ? (
                        <span className="line-clamp-2 text-[#a12b2b]">{row.error}</span>
                      ) : (
                        <span className="line-clamp-2 text-admin-muted">{row.result || "—"}</span>
                      )}
                    </td>
                    <td className={cn(TD, "whitespace-nowrap text-right")}>
                      <AdminButton size="sm" variant="ghost" onClick={() => setOpenId(row.eventId)} aria-label={`View event ${row.eventId}`}>
                        View
                      </AdminButton>
                      {row.replayable ? (
                        <AdminButton size="sm" variant="ghost" onClick={() => setReplaying(row)} aria-label={`Replay event ${row.eventId}`}>
                          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                          Replay
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
        <LogFooter
          page={data.pagination.page}
          pageSize={pageSize}
          total={data.pagination.total}
          totalPages={data.pagination.total_pages}
          onPage={setPage}
          onPageSize={setPageSize}
        />
      ) : null}

      <Modal open={openId !== null} onOpenChange={(open) => !open && setOpenId(null)} title="Webhook event" className="max-w-2xl">
        {detail.isLoading || !detail.data ? (
          <p className="text-sm text-ink-500">{detail.error ? problem(detail.error, "This event didn't load.") : "Loading…"}</p>
        ) : (
          <div className="flex flex-col gap-5 text-xs">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail label="Event">{detail.data.event}</Detail>
              <Detail label="Status">
                <Badge tone={(STATUS[detail.data.status] ?? STATUS.processing).tone}>{(STATUS[detail.data.status] ?? STATUS.processing).label}</Badge>
              </Detail>
              <Detail label="Event ID" wide>
                {detail.data.eventId}
              </Detail>
              <Detail label="Received">{formatDateTime(detail.data.receivedAt)}</Detail>
              <Detail label="Finished">
                {detail.data.completedAt ? formatDateTime(detail.data.completedAt) : "—"}
                {detail.data.durationMs !== null ? ` (${detail.data.durationMs} ms)` : ""}
              </Detail>
              <Detail label="Order">{detail.data.orderNumber ?? "—"}</Detail>
              <Detail label="Payment">{detail.data.paymentId ?? "—"}</Detail>
              <Detail label="Razorpay payment">{detail.data.gatewayPaymentId ?? "—"}</Detail>
              <Detail label="Refund">{detail.data.refundId ?? "—"}</Detail>
              <Detail label="Duplicates">
                {detail.data.duplicates}
                {detail.data.lastDuplicateAt ? ` · last ${formatDateTime(detail.data.lastDuplicateAt)}` : ""}
              </Detail>
              <Detail label="Result">{detail.data.result || "—"}</Detail>
              {detail.data.error ? (
                <Detail label="Error" wide>
                  <span className="text-[#a12b2b]">{detail.data.error}</span>
                </Detail>
              ) : null}
            </dl>

            <section>
              <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">Attempts</h3>
              <ol className="flex flex-col gap-2">
                {detail.data.attemptLog.length === 0 ? <li className="text-admin-muted">Recorded before attempts were logged.</li> : null}
                {detail.data.attemptLog.map((attempt) => (
                  <li key={attempt.number} className="rounded-[3px] border border-admin-border p-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-admin-ink">
                        #{attempt.number} · {TRIGGER[attempt.trigger] ?? attempt.trigger}
                      </span>
                      <Badge tone={attempt.outcome === "failed" ? "red" : attempt.outcome === "processed" ? "green" : "grey"}>
                        {attempt.outcome || "Running"}
                      </Badge>
                    </div>
                    <p className="mt-1 text-admin-muted">{formatDateTime(attempt.startedAt)}</p>
                    {attempt.error ? <p className="mt-1 text-[#a12b2b]">{attempt.error}</p> : attempt.result ? <p className="mt-1 text-admin-muted">{attempt.result}</p> : null}
                  </li>
                ))}
              </ol>
            </section>

            <section>
              <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">What was kept of the event</h3>
              <p className="mb-2 text-admin-muted">Ids, amounts and statuses only — customer contact, card and account details are never stored.</p>
              {detail.data.payload ? <JsonBlock value={detail.data.payload} /> : <p className="text-admin-muted">Not kept for events recorded before monitoring began.</p>}
            </section>

            {detail.data.replayable ? (
              <AdminButton variant="primary" onClick={() => setReplaying(detail.data)}>
                <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Replay this event
              </AdminButton>
            ) : null}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={replaying !== null}
        onOpenChange={(open) => !open && setReplaying(null)}
        title="Replay this event?"
        destructive={false}
        message="It runs through the same checks as a delivery from Razorpay. A payment that has since been settled stays settled once — nothing is charged or paid twice."
        confirmLabel="Replay event"
        loading={busy}
        onConfirm={() => void replay()}
      />
    </div>
  );
}
