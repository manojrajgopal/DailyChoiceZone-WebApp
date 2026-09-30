"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { ArrowLeft, ChevronDown, Download, RefreshCw, X } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import {
  FilterSelect,
  LogFooter,
  LogSearch,
  StatusTabs,
  collectPages,
  downloadCsv,
  useUrlFilters,
} from "@/components/admin/ui/LogPage";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatAgo, formatDateTime } from "@/lib/support/format";
import { ApiError } from "@/services/api/client";
import { searchEmailLog, type EmailLogEntry } from "@/services/emailSettingsService";
import { toast } from "@/store/toastStore";

import { LogStatusBadge } from "./AdminEmailSettingsView";

const KEYS = ["status", "type", "q", "from", "to"] as const;

/** A support request number, e.g. DCZ-2026-000123 — linked to the desk. */
const TICKET = /^[A-Z0-9]{2,6}-\d{4}-\d{6}$/;

/**
 * Every email the store has sent — the full log behind "Recent emails" on the
 * email settings page. Filtered, searched and paged on the server; the
 * filters live in the address bar so a view can be shared.
 */
export function AdminEmailHistoryView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const [open, setOpen] = useState<number | string | null>(null);
  const [exporting, setExporting] = useState(false);

  const query = {
    status: filters.status,
    type: filters.type,
    q: filters.q,
    from: filters.from ? `${filters.from}T00:00:00+05:30` : "",
    to: filters.to ? `${filters.to}T23:59:59+05:30` : "",
  };
  const log = useAdminResource(() => searchEmailLog({ ...query, page, pageSize }), [filters, page, pageSize]);

  const data = log.data;
  const labels = new Map((data?.types ?? []).map((type) => [type.key, type.label]));
  // An email type no longer configured still reads as words: "shipping_updates" → "Shipping updates".
  const typeLabel = (key: string) =>
    key === "test" ? "Test email" : (labels.get(key) ?? key.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()));
  const all = data ? data.counts.sent + data.counts.failed : 0;
  const filtered = Boolean(filters.type || filters.q || filters.from || filters.to);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { rows, truncated } = await collectPages((p) => searchEmailLog({ ...query, page: p, pageSize: 100 }));
      downloadCsv(
        `email-history-${new Date().toISOString().slice(0, 10)}.csv`,
        ["Time", "Email", "Type", "Sent to", "Status", "Error", "Reference"],
        rows.map((row) => [formatDateTime(row.at), row.subject, typeLabel(row.type), row.recipient, row.status, row.error ?? "", row.reference ?? ""]),
      );
      toast.success(truncated ? `Exported the newest ${rows.length.toLocaleString("en-IN")} emails.` : `Exported ${rows.length.toLocaleString("en-IN")} emails.`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "The export didn't work. Please try again.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="Email history"
        description="Every email sent from your store — order updates, support replies, staff alerts and tests — with what happened to each."
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Email", href: "/admin/settings/email" },
          { label: "History" },
        ]}
        actions={
          <>
            <AdminButtonLink href="/admin/settings/email" size="sm">
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Email settings
            </AdminButtonLink>
            <AdminButton size="sm" onClick={() => void log.reload()} loading={log.isRefreshing}>
              {log.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Refresh
            </AdminButton>
            <AdminButton size="sm" variant="primary" onClick={() => void exportCsv()} loading={exporting} disabled={!data || data.pagination.total === 0}>
              {exporting ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Export CSV
            </AdminButton>
          </>
        }
      />

      {/* ------------------------------------------------------------ totals */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={filtered ? "Matching" : "All emails"} value={data ? all.toLocaleString("en-IN") : null} />
        <Tile label="Sent" value={data ? data.counts.sent.toLocaleString("en-IN") : null} tone="good" />
        <Tile label="Failed" value={data ? data.counts.failed.toLocaleString("en-IN") : null} tone={data?.counts.failed ? "bad" : undefined} />
        <Tile label="Delivery rate" value={data ? (all ? `${Math.round((1000 * data.counts.sent) / all) / 10}%` : "—") : null} />
      </div>

      <StatusTabs
        label="Filter by status"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "All", count: data ? all : undefined },
          { value: "sent", label: "Sent", count: data?.counts.sent },
          { value: "failed", label: "Failed", count: data?.counts.failed },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch
          label="Search emails"
          value={filters.q}
          onChange={(q) => setFilters({ q })}
          placeholder="Search recipient, subject or reference (order or request number)"
        />
        <FilterSelect
          label="Email type"
          value={filters.type}
          onChange={(type) => setFilters({ type })}
          options={[{ value: "", label: "All email types" }, { value: "test", label: "Test email" }, ...(data?.types ?? []).map((t) => ({ value: t.key, label: t.label }))]}
        />
        <DateInput label="From" value={filters.from} max={filters.to || undefined} onChange={(from) => setFilters({ from })} />
        <DateInput label="To" value={filters.to} min={filters.from || undefined} onChange={(to) => setFilters({ to })} />
        {filtered || filters.status ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        {log.error && !data ? (
          <div className="py-10 text-center">
            <p className="text-sm text-admin-ink">The email history didn&rsquo;t load.</p>
            <AdminButton size="sm" className="mt-3" onClick={() => void log.reload()}>
              Try again
            </AdminButton>
          </div>
        ) : (
          <div className="relative overflow-x-auto">
            <table className={cn("w-full min-w-[56rem] text-left text-xs", log.isRefreshing && "opacity-60")}>
              <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                <tr>
                  <th className="w-8 px-2 py-2.5" aria-label="Details" />
                  <th className="px-3 py-2.5 font-medium">Email</th>
                  <th className="px-3 py-2.5 font-medium">Sent to</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Reference</th>
                  <th className="px-3 py-2.5 text-right font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-admin-border">
                {log.isLoading && !data ? (
                  Array.from({ length: 8 }, (_, index) => (
                    <tr key={index}>
                      {Array.from({ length: 6 }, (__, cell) => (
                        <td key={cell} className="px-3 py-3.5">
                          <span className="block h-3 w-full max-w-32 animate-pulse rounded-[2px] bg-admin-border" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : !data || data.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-14 text-center">
                      <p className="text-sm font-medium text-admin-ink">{filtered || filters.status ? "No emails match" : "No emails sent yet"}</p>
                      <p className="mt-1 text-xs text-admin-muted">
                        {filtered || filters.status ? "Try a different filter or search." : "Emails appear here as soon as your store sends them."}
                      </p>
                    </td>
                  </tr>
                ) : (
                  data.items.map((entry) => (
                    <Row
                      key={entry.id}
                      entry={entry}
                      typeLabel={typeLabel(entry.type)}
                      open={open === entry.id}
                      onToggle={() => setOpen((current) => (current === entry.id ? null : entry.id))}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
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
    </div>
  );
}

function Row({ entry, typeLabel, open, onToggle }: { entry: EmailLogEntry; typeLabel: string; open: boolean; onToggle: () => void }) {
  const reference = entry.reference || "";
  return (
    <Fragment>
      <tr className={cn("cursor-pointer align-top transition-colors hover:bg-admin-raised", open && "bg-admin-raised")} onClick={onToggle}>
        <td className="px-2 py-3">
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} details for ${entry.subject}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded-[3px] text-admin-muted hover:bg-admin-border"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
          </button>
        </td>
        <td className="max-w-sm px-3 py-3">
          <span className="block font-medium text-admin-ink">{entry.subject || "—"}</span>
          <span className="mt-0.5 block text-[0.6875rem] text-admin-muted">{typeLabel}</span>
          {entry.status === "failed" && entry.error ? (
            <span className="mt-1 block truncate text-[0.6875rem] text-[#a12b2b]">{entry.error}</span>
          ) : null}
        </td>
        <td className="px-3 py-3 text-admin-ink">{entry.recipient}</td>
        <td className="px-3 py-3">
          <LogStatusBadge status={entry.status} />
        </td>
        <td className="px-3 py-3 text-admin-muted">
          {reference && TICKET.test(reference) ? (
            <Link
              href={`/admin/support?view=all&q=${encodeURIComponent(reference)}`}
              onClick={(event) => event.stopPropagation()}
              className="text-copper-700 hover:underline"
            >
              {reference}
            </Link>
          ) : (
            reference || "—"
          )}
        </td>
        <td className="whitespace-nowrap px-3 py-3 text-right text-admin-muted">
          <span className="block text-admin-ink">{formatDateTime(entry.at)}</span>
          <span className="text-[0.6875rem]">{formatAgo(entry.at)}</span>
        </td>
      </tr>
      {open ? (
        <tr className="bg-admin-raised">
          <td />
          <td colSpan={5} className="px-3 pb-4 pt-1">
            <dl className="grid gap-x-6 gap-y-2 rounded-[3px] border border-admin-border bg-admin-surface p-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Log entry">#{entry.id}</Detail>
              <Detail label="Email type">
                {typeLabel} <span className="text-admin-faint">({entry.type})</span>
              </Detail>
              <Detail label="Recipient">{entry.recipient}</Detail>
              <Detail label="Logged at">{formatDateTime(entry.at)}</Detail>
              <Detail label="Subject" wide>
                {entry.subject || "—"}
              </Detail>
              <Detail label={entry.status === "failed" ? "Why it failed" : "Result"} wide>
                {entry.status === "failed" ? (
                  <span className="text-[#a12b2b]">{entry.error || "The provider refused it without a reason."}</span>
                ) : (
                  "Accepted by the email provider for delivery."
                )}
              </Detail>
            </dl>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function Detail({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn(wide && "sm:col-span-2")}>
      <dt className="text-[0.6875rem] text-admin-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-admin-ink">{children}</dd>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string | null; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-[3px] border border-admin-border bg-admin-surface p-3.5">
      <p className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">{label}</p>
      <p className={cn("mt-1.5 text-xl font-semibold tabular-nums", tone === "good" ? "text-[#0a6b0a]" : tone === "bad" ? "text-[#a32424]" : "text-admin-ink")}>
        {value ?? <span className="inline-block h-5 w-12 animate-pulse rounded-[2px] bg-admin-border" />}
      </p>
    </div>
  );
}

function DateInput({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-admin-muted">
      {label}
      <input
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] text-admin-ink"
      />
    </label>
  );
}
