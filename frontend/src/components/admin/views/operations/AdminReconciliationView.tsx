"use client";

import { useState } from "react";
import { Play, RefreshCw, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminTextarea } from "@/components/admin/ui/AdminForm";
import { FilterSelect, LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatAgo, formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";
import {
  getReconciliation,
  listReconciliation,
  recheckReconciliation,
  reopenReconciliation,
  resolveReconciliation,
  runReconciliation,
  type ReconciliationStatus,
} from "@/services/admin/operationsAdminService";
import { toast } from "@/store/toastStore";

import { Badge, Detail, JsonBlock, TD, TH, TableState, Tile, problem } from "./shared";

const KEYS = ["status", "resolution", "q"] as const;

const STATUS: Record<ReconciliationStatus, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  matched: { label: "Matched", tone: "green" },
  mismatch: { label: "Mismatch", tone: "red" },
  "missing-locally": { label: "Missing here", tone: "red" },
  "missing-externally": { label: "Missing at gateway", tone: "red" },
  "requires-review": { label: "Needs review", tone: "amber" },
};

const ACTION: Record<string, string> = {
  checked: "Checked",
  resolved: "Marked resolved",
  reopened: "Reopened",
};

function isoDay(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * Our payments against Razorpay's. A run only records what it finds: nothing
 * here settles, refunds or edits a payment. Resolving a finding records that
 * someone reviewed it, with their note.
 */
export function AdminReconciliationView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  // The last seven days by default, read once when the page opens.
  const [today] = useState(() => isoDay(new Date()));
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(today);
  const [running, setRunning] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [acting, setActing] = useState<"" | "recheck" | "resolve" | "reopen">("");

  const list = useAdminResource(
    () => listReconciliation({ status: filters.status || "issues", resolution: filters.resolution, q: filters.q, page, pageSize }),
    [filters, page, pageSize],
  );
  const detail = useAdminResource(() => getReconciliation(openId ?? 0), [openId], { enabled: openId !== null });
  const data = list.data;
  const open = data?.open ?? {};
  const openIssues = Object.entries(open).reduce((sum, [status, count]) => (status === "matched" ? sum : sum + count), 0);
  const filtered = Boolean(filters.status || filters.resolution || filters.q);

  const run = async () => {
    setRunning(true);
    try {
      const result = await runReconciliation(from, to);
      const issues = result.checked - (result.counts.matched ?? 0);
      if (issues) toast.error(`Checked ${result.checked} payments: ${issues} need a look.`);
      else toast.success(`Checked ${result.checked} payments: all match Razorpay.`);
      await list.reload();
    } catch (error) {
      toast.error(problem(error, "The reconciliation didn't run. Please try again."));
    } finally {
      setRunning(false);
    }
  };

  const act = async (kind: "recheck" | "resolve" | "reopen") => {
    if (openId === null) return;
    setActing(kind);
    try {
      if (kind === "recheck") await recheckReconciliation(openId);
      else if (kind === "resolve") await resolveReconciliation(openId, note);
      else await reopenReconciliation(openId, note);
      toast.success(kind === "recheck" ? "Checked again with Razorpay." : kind === "resolve" ? "Marked resolved." : "Reopened.");
      setNote("");
      await Promise.all([detail.reload(), list.reload()]);
    } catch (error) {
      toast.error(problem(error, "That didn't work. Please try again."));
    } finally {
      setActing("");
    }
  };

  const row = detail.data;

  return (
    <div>
      <AdminPageHeader
        title="Payment reconciliation"
        description="Compare payments recorded here with Razorpay: amounts, currency, status and refunds. Findings are for review — nothing is changed automatically."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Billing", href: "/admin/billing" }, { label: "Reconciliation" }]}
        actions={
          <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
            {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Refresh
          </AdminButton>
        }
      />

      <AdminCard title="Run a reconciliation" description="Checks every Razorpay payment created in the range (up to 31 days) against the gateway." className="mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-admin-muted">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
              className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] text-admin-ink"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-admin-muted">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(event) => setTo(event.target.value)}
              className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] text-admin-ink"
            />
          </label>
          <AdminButton variant="primary" onClick={() => void run()} loading={running} disabled={!from || !to}>
            {running ? null : <Play className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Run reconciliation
          </AdminButton>
          <p className="text-xs text-admin-muted">
            {data?.lastCheckedAt ? `Last checked ${formatAgo(data.lastCheckedAt)}.` : data ? "Not run yet." : ""}
          </p>
        </div>
      </AdminCard>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Open findings" value={data ? openIssues.toLocaleString("en-IN") : null} tone={openIssues ? "bad" : "good"} />
        <Tile label="Mismatches" value={data ? String(open.mismatch ?? 0) : null} tone={open.mismatch ? "bad" : undefined} />
        <Tile label="Missing here" value={data ? String(open["missing-locally"] ?? 0) : null} tone={open["missing-locally"] ? "bad" : undefined} />
        <Tile label="Missing at gateway" value={data ? String(open["missing-externally"] ?? 0) : null} tone={open["missing-externally"] ? "bad" : undefined} />
        <Tile label="Needs review" value={data ? String(open["requires-review"] ?? 0) : null} tone={open["requires-review"] ? "warn" : undefined} />
      </div>

      <StatusTabs
        label="Filter findings"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "With issues" },
          { value: "mismatch", label: "Mismatch" },
          { value: "missing-locally", label: "Missing here" },
          { value: "missing-externally", label: "Missing at gateway" },
          { value: "requires-review", label: "Needs review" },
          { value: "matched", label: "Matched" },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch label="Search findings" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Payment ID, Razorpay payment ID or order number" />
        <FilterSelect
          label="Resolution"
          value={filters.resolution}
          onChange={(resolution) => setFilters({ resolution })}
          options={[
            { value: "", label: "Open and resolved" },
            { value: "open", label: "Open" },
            { value: "resolved", label: "Resolved" },
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
          <table className={cn("w-full min-w-[58rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Payment</th>
                <th className={TH}>Order</th>
                <th className={TH}>Status</th>
                <th className={TH}>Findings</th>
                <th className={cn(TH, "text-right")}>Amount</th>
                <th className={TH}>Checked</th>
                <th className={TH}>Review</th>
                <th className={cn(TH, "text-right")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={8}
                loading={list.isLoading && !data}
                failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void list.reload()}
                title={filtered ? "Nothing matches" : "No findings"}
                hint={filtered ? "Try a different filter or search." : "Run a reconciliation to compare payments with Razorpay."}
              />
              {data?.items.map((item) => {
                const status = STATUS[item.status] ?? STATUS["requires-review"];
                return (
                  <tr key={item.id} className="align-top hover:bg-admin-raised">
                    <td className={TD}>
                      <span className="block font-medium text-admin-ink">{item.paymentId ?? "Not recorded here"}</span>
                      <span className="block text-[0.625rem] text-admin-faint">{item.gatewayPaymentId ?? ""}</span>
                    </td>
                    <td className={cn(TD, "text-admin-ink")}>{item.orderNumber || "—"}</td>
                    <td className={TD}>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td className={cn(TD, "max-w-[18rem] text-admin-muted")}>
                      {item.issues.length ? item.issues.map((issue) => issue.label).join(" · ") : "Matches the gateway"}
                    </td>
                    <td className={cn(TD, "text-right tabular-nums text-admin-ink")}>
                      {item.amount !== null ? formatPrice(item.amount) : "—"}
                    </td>
                    <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(item.checkedAt)}</td>
                    <td className={TD}>
                      {item.status === "matched" ? (
                        <span className="text-admin-faint">—</span>
                      ) : (
                        <Badge tone={item.resolution === "resolved" ? "green" : "amber"}>{item.resolution === "resolved" ? "Resolved" : "Open"}</Badge>
                      )}
                    </td>
                    <td className={cn(TD, "text-right")}>
                      <AdminButton size="sm" variant="ghost" onClick={() => setOpenId(item.id)} aria-label={`Review finding for ${item.paymentId ?? item.gatewayPaymentId}`}>
                        Review
                      </AdminButton>
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

      <Modal
        open={openId !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setOpenId(null);
            setNote("");
          }
        }}
        title="Reconciliation finding"
        className="max-w-2xl"
      >
        {!row ? (
          <p className="text-sm text-ink-500">{detail.error ? problem(detail.error, "This didn't load.") : "Loading…"}</p>
        ) : (
          <div className="flex flex-col gap-5 text-xs">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail label="Status">
                <Badge tone={(STATUS[row.status] ?? STATUS["requires-review"]).tone}>{(STATUS[row.status] ?? STATUS["requires-review"]).label}</Badge>
              </Detail>
              <Detail label="Review">{row.resolution === "resolved" ? `Resolved ${row.resolvedAt ? formatDateTime(row.resolvedAt) : ""}` : "Open"}</Detail>
              <Detail label="Payment">{row.paymentId ?? "Not recorded here"}</Detail>
              <Detail label="Razorpay payment">{row.gatewayPaymentId ?? "—"}</Detail>
              <Detail label="Order">{row.orderNumber || "—"}</Detail>
              <Detail label="Checked">
                {formatDateTime(row.checkedAt)} · {row.checkCount} {row.checkCount === 1 ? "check" : "checks"}
              </Detail>
              <Detail label="Findings" wide>
                {row.summary}
              </Detail>
              {row.checkError ? (
                <Detail label="Couldn't check" wide>
                  <span className="text-[#a12b2b]">{row.checkError}</span>
                </Detail>
              ) : null}
              {row.resolutionNote ? (
                <Detail label="Resolution note" wide>
                  {row.resolutionNote}
                </Detail>
              ) : null}
            </dl>

            <div className="grid gap-3 sm:grid-cols-2">
              <section>
                <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">Recorded here</h3>
                {row.local ? <JsonBlock value={row.local} /> : <p className="text-admin-muted">No payment of ours.</p>}
              </section>
              <section>
                <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">At Razorpay</h3>
                {row.gateway ? <JsonBlock value={row.gateway} /> : <p className="text-admin-muted">Nothing found at the gateway.</p>}
              </section>
            </div>

            <section>
              <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">History</h3>
              <ol className="flex flex-col gap-1.5">
                {row.events.map((event, index) => (
                  <li key={index} className="border-l-2 border-admin-border pl-2.5">
                    <span className="font-medium text-admin-ink">{ACTION[event.action] ?? event.action}</span>
                    <span className="text-admin-muted">
                      {" "}
                      · {formatDateTime(event.at)}
                      {event.adminName ? ` · ${event.adminName}` : ""}
                    </span>
                    {event.note ? <p className="text-admin-muted">{event.note}</p> : null}
                  </li>
                ))}
              </ol>
            </section>

            {row.status !== "matched" ? (
              <AdminTextarea
                label={row.resolution === "resolved" ? "Why reopen it?" : "What did you find or do?"}
                hint="Required. Kept in the history. Resolving records the review — it doesn't change the payment."
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                maxLength={1000}
              />
            ) : null}

            <div className="flex flex-wrap gap-2">
              <AdminButton onClick={() => void act("recheck")} loading={acting === "recheck"} disabled={acting !== ""}>
                Check again
              </AdminButton>
              {row.status !== "matched" && row.resolution === "open" ? (
                <AdminButton variant="primary" onClick={() => void act("resolve")} loading={acting === "resolve"} disabled={acting !== "" || note.trim().length < 5}>
                  Mark resolved
                </AdminButton>
              ) : null}
              {row.resolution === "resolved" ? (
                <AdminButton onClick={() => void act("reopen")} loading={acting === "reopen"} disabled={acting !== "" || note.trim().length < 5}>
                  Reopen
                </AdminButton>
              ) : null}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
