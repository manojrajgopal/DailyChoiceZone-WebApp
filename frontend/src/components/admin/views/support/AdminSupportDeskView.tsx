"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Timer,
  X,
} from "lucide-react";

import {
  getDeskLookups,
  getSupportDashboard,
  listDeskTickets,
  type DeskFilters,
  type StaffTicketRow,
  type SupportDashboard,
} from "@/services/supportService";

import { BarList } from "@/components/admin/charts/BarList";
import { TimeSeriesChart } from "@/components/admin/charts/TimeSeriesChart";
import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminPagination } from "@/components/admin/ui/AdminPagination";
import { useAdminResource } from "@/hooks/useAdminResource";
import { usePoll } from "@/hooks/usePoll";
import { cn } from "@/lib/utils/cn";
import { formatAgo, formatDuration } from "@/lib/support/format";

import { NoSupportAccess, PriorityBadge, SlaChip, TicketStatusBadge, useSupportMe } from "./SupportDeskParts";

const PAGE_SIZE = 25;

/** Saved views across the top of the list. */
const VIEWS: { id: string; label: string; filters: DeskFilters }[] = [
  { id: "open", label: "Open", filters: { view: "open" } },
  { id: "mine", label: "Assigned to me", filters: { view: "open", agent: "me" } },
  { id: "unassigned", label: "Unassigned", filters: { view: "open", agent: "unassigned" } },
  { id: "waiting", label: "Waiting on customer", filters: { view: "waiting" } },
  { id: "breached", label: "SLA breached", filters: { sla: "breached" } },
  { id: "done", label: "Resolved & closed", filters: { view: "done" } },
  // Explicit, because an empty address means the default ("Open") view.
  { id: "all", label: "All", filters: { view: "all" } },
];

/** The keys the list reads from, and writes to, the address bar. */
const FILTER_KEYS: (keyof DeskFilters)[] = [
  "view", "status", "category", "subcategory", "priority", "team", "agent", "channel", "contactType", "sla", "q", "sort", "from", "to",
];

function filtersFrom(params: URLSearchParams): DeskFilters {
  const out: DeskFilters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) (out as Record<string, string>)[key] = value;
  }
  if (Object.keys(out).length === 0) out.view = "open";
  return out;
}

/**
 * The support desk: where every request is, what needs attention first, and
 * the way into each ticket. Filters, sorting and paging run in the database;
 * the address bar carries them, so a view can be bookmarked or shared.
 */
export function AdminSupportDeskView() {
  const me = useSupportMe();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<"tickets" | "insights">(params.get("tab") === "insights" ? "insights" : "tickets");

  if (me.isLoading) {
    return (
      <div className="flex h-60 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading" />
      </div>
    );
  }
  if (!me.data?.canWork) {
    return (
      <div>
        <AdminPageHeader title="Support" breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Support" }]} />
        <NoSupportAccess />
      </div>
    );
  }

  return (
    <div>
      <AdminPageHeader
        title="Support desk"
        description={
          me.data.seesEverything
            ? "Every customer request, what needs attention first, and how the team is doing."
            : `Requests for ${me.data.agent?.team || "your team"} and those assigned to you.`
        }
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Support" }]}
        actions={
          me.data.canConfigure ? (
            <AdminButtonLink href="/admin/support/settings" size="sm">
              <Settings className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Support setup
            </AdminButtonLink>
          ) : null
        }
      />

      <div role="tablist" aria-label="Desk sections" className="mb-5 flex gap-5 border-b border-admin-border">
        {(["tickets", "insights"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id);
              const next = new URLSearchParams(params.toString());
              if (id === "insights") next.set("tab", "insights");
              else next.delete("tab");
              router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
            }}
            className={cn(
              "-mb-px border-b-2 pb-2.5 text-sm font-medium transition-colors",
              tab === id ? "border-copper-600 text-admin-ink" : "border-transparent text-admin-muted hover:text-admin-ink",
            )}
          >
            {id === "tickets" ? "Tickets" : "Insights"}
          </button>
        ))}
      </div>

      {tab === "tickets" ? <TicketsTab /> : <InsightsTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ tickets */

function TicketsTab() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters = useMemo(() => filtersFrom(new URLSearchParams(params.toString())), [params]);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [term, setTerm] = useState(filters.q ?? "");
  const [showFilters, setShowFilters] = useState(false);

  const apply = useCallback(
    (next: DeskFilters, nextPage = 1) => {
      const search = new URLSearchParams();
      for (const key of FILTER_KEYS) {
        const value = next[key];
        if (value) search.set(key, String(value));
      }
      if (nextPage > 1) search.set("page", String(nextPage));
      router.replace(`${pathname}?${search.toString()}`, { scroll: false });
    },
    [pathname, router],
  );

  // Search as they type, a moment after they stop.
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.q ?? "") !== term.trim()) apply({ ...filters, q: term.trim() || undefined });
    }, 350);
    return () => clearTimeout(timer);
  }, [term, filters, apply]);

  const lookups = useAdminResource(() => getDeskLookups(), []);
  const dashboard = useAdminResource(() => getSupportDashboard(30), []);
  const list = useAdminResource(() => listDeskTickets({ ...filters, page, pageSize: PAGE_SIZE }), [filters, page]);

  // New requests and replies arrive without a refresh.
  usePoll(() => {
    void list.reload();
    void dashboard.reload();
  }, 30_000);

  const activeView = VIEWS.find(
    (view) =>
      FILTER_KEYS.every((key) => (view.filters[key] ?? "") === (filters[key] ?? "") || key === "q" || key === "sort"),
  )?.id;

  const set = (patch: DeskFilters) => apply({ ...filters, ...patch });
  const extraFilterCount = (["status", "category", "subcategory", "priority", "team", "channel", "contactType", "from", "to"] as const).filter(
    (key) => filters[key],
  ).length;

  const categories = lookups.data?.categories ?? [];
  const chosenCategory = categories.find((node) => String(node.id) === filters.category);
  const totals = dashboard.data?.totals;

  const cards: { label: string; value: number | undefined; icon: typeof Inbox; patch: DeskFilters; alert?: boolean }[] = [
    { label: "Total", value: totals?.total, icon: Inbox, patch: { view: "all" } },
    { label: "Open", value: totals?.open, icon: MessageSquare, patch: { status: "submitted,triaged,assigned,acknowledged,reopened,escalated" } },
    { label: "In progress", value: totals?.inProgress, icon: Timer, patch: { status: "in-progress,waiting-internal" } },
    { label: "Waiting", value: totals?.waitingCustomer, icon: Clock, patch: { view: "waiting" } },
    { label: "Urgent", value: totals?.urgent, icon: AlertTriangle, patch: { view: "open", priority: "urgent" }, alert: true },
    { label: "SLA breached", value: totals?.slaBreached, icon: AlertTriangle, patch: { sla: "breached" }, alert: true },
    { label: "Resolved", value: totals?.resolved, icon: CheckCircle2, patch: { status: "resolved" } },
    { label: "Closed", value: totals?.closed, icon: CheckCircle2, patch: { status: "closed" } },
  ];

  return (
    <div>
      {/* ---------------------------------------------------------- cards */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {cards.map((card) => {
          const Icon = card.icon;
          const hot = card.alert && (card.value ?? 0) > 0;
          return (
            <button
              key={card.label}
              type="button"
              onClick={() => apply({ ...card.patch })}
              className={cn(
                "flex flex-col rounded-[3px] border bg-admin-surface p-3 text-left transition-colors",
                hot ? "border-[#d03b3b]/30 hover:border-[#d03b3b]/60" : "border-admin-border hover:border-admin-border-strong",
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">{card.label}</span>
                <Icon className={cn("h-3.5 w-3.5", hot ? "text-[#a32424]" : "text-admin-faint")} strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span className={cn("mt-2 text-xl font-semibold tabular-nums", hot ? "text-[#a32424]" : "text-admin-ink")}>
                {card.value === undefined ? <span className="inline-block h-5 w-8 animate-pulse rounded-[2px] bg-admin-border" /> : card.value}
              </span>
            </button>
          );
        })}
      </div>

      {/* ---------------------------------------------------------- views */}
      <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Saved views">
        {VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={activeView === view.id}
            onClick={() => apply({ ...view.filters, q: filters.q, sort: filters.sort })}
            className={cn(
              "rounded-[3px] px-2.5 py-1.5 text-xs transition-colors",
              activeView === view.id
                ? "bg-admin-ink text-white"
                : "bg-admin-surface text-admin-muted ring-1 ring-inset ring-admin-border hover:text-admin-ink",
            )}
          >
            {view.label}
          </button>
        ))}
      </div>

      {/* --------------------------------------------------------- filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint" aria-hidden="true" />
          <label htmlFor="desk-search" className="sr-only">
            Search tickets
          </label>
          <input
            id="desk-search"
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Ticket number, subject, customer, email, order or agent"
            className="h-9 w-full rounded-[3px] border border-admin-border bg-admin-surface pl-8 pr-2.5 text-[0.8125rem] text-admin-ink placeholder:text-admin-faint hover:border-admin-border-strong focus:border-copper-500"
          />
        </div>
        <DeskSelect
          label="Agent"
          value={filters.agent ?? ""}
          onChange={(agent) => set({ agent })}
          options={[
            { value: "", label: "Any agent" },
            { value: "me", label: "Me" },
            { value: "unassigned", label: "Unassigned" },
            ...(lookups.data?.agents ?? []).map((agent) => ({ value: String(agent.id), label: agent.name + (agent.active ? "" : " (inactive)") })),
          ]}
        />
        <DeskSelect
          label="SLA"
          value={filters.sla ?? ""}
          onChange={(sla) => set({ sla })}
          options={[
            { value: "", label: "Any SLA" },
            { value: "breached", label: "Breached" },
            { value: "due-soon", label: "Due in 2 hours" },
            { value: "on-track", label: "On track" },
          ]}
        />
        <DeskSelect
          label="Sort"
          value={filters.sort ?? "updated"}
          onChange={(sort) => set({ sort })}
          options={[
            { value: "updated", label: "Recently updated" },
            { value: "created", label: "Newest" },
            { value: "oldest", label: "Oldest" },
            { value: "priority", label: "Priority" },
            { value: "due", label: "Due soonest" },
          ]}
        />
        <AdminButton size="sm" onClick={() => setShowFilters((value) => !value)} aria-expanded={showFilters}>
          <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
          Filters{extraFilterCount ? ` (${extraFilterCount})` : ""}
        </AdminButton>
        <AdminButton size="sm" variant="ghost" onClick={() => void list.reload()} aria-label="Refresh" loading={list.isRefreshing}>
          {!list.isRefreshing ? <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> : null}
        </AdminButton>
      </div>

      {showFilters ? (
        <AdminCard className="mb-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <DeskSelect
              label="Status"
              block
              value={filters.status ?? ""}
              onChange={(status) => set({ status, view: status ? undefined : filters.view })}
              options={[{ value: "", label: "Any status" }, ...(lookups.data?.statuses ?? [])]}
            />
            <DeskSelect
              label="Priority"
              block
              value={filters.priority ?? ""}
              onChange={(priority) => set({ priority })}
              options={[{ value: "", label: "Any priority" }, ...(lookups.data?.priorities ?? [])]}
            />
            <DeskSelect
              label="Category"
              block
              value={filters.category ?? ""}
              onChange={(category) => set({ category, subcategory: undefined })}
              options={[{ value: "", label: "Any category" }, ...categories.map((node) => ({ value: String(node.id), label: node.name }))]}
            />
            <DeskSelect
              label="Subcategory"
              block
              disabled={!chosenCategory}
              value={filters.subcategory ?? ""}
              onChange={(subcategory) => set({ subcategory })}
              options={[
                { value: "", label: chosenCategory ? "Any subcategory" : "Choose a category first" },
                ...(chosenCategory?.children ?? []).map((node) => ({ value: String(node.id), label: node.name })),
              ]}
            />
            <DeskSelect
              label="Team"
              block
              value={filters.team ?? ""}
              onChange={(team) => set({ team })}
              options={[{ value: "", label: "Any team" }, ...(lookups.data?.teams ?? []).map((team) => ({ value: String(team.id), label: team.name }))]}
            />
            <DeskSelect
              label="Channel"
              block
              value={filters.channel ?? ""}
              onChange={(channel) => set({ channel })}
              options={[
                { value: "", label: "Any channel" },
                { value: "form", label: "Contact form" },
                { value: "chat", label: "Live chat" },
              ]}
            />
            <label className="flex flex-col gap-1.5 text-xs font-medium text-admin-ink">
              Raised from
              <input
                type="date"
                value={filters.from?.slice(0, 10) ?? ""}
                onChange={(event) => set({ from: event.target.value || undefined })}
                className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2.5 text-[0.8125rem] font-normal text-admin-ink"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-medium text-admin-ink">
              Raised until
              <input
                type="date"
                value={filters.to?.slice(0, 10) ?? ""}
                onChange={(event) => set({ to: event.target.value ? `${event.target.value}T23:59:59` : undefined })}
                className="h-9 rounded-[3px] border border-admin-border bg-admin-surface px-2.5 text-[0.8125rem] font-normal text-admin-ink"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <AdminButton size="sm" variant="ghost" onClick={() => apply({ view: "open" })}>
              <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Clear all filters
            </AdminButton>
          </div>
        </AdminCard>
      ) : null}

      {/* ----------------------------------------------------------- table */}
      {list.error && !list.data ? (
        <AdminCard>
          <div className="py-8 text-center">
            <p className="text-sm text-admin-ink">The tickets didn&rsquo;t load.</p>
            <AdminButton size="sm" className="mt-3" onClick={() => void list.reload()}>
              Try again
            </AdminButton>
          </div>
        </AdminCard>
      ) : (
        <TicketTable rows={list.data?.items ?? []} loading={list.isLoading} />
      )}

      {list.data && list.data.total > 0 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs tabular-nums text-admin-muted">
            Showing {(list.data.page - 1) * PAGE_SIZE + 1}–{Math.min(list.data.page * PAGE_SIZE, list.data.total)} of {list.data.total}
          </p>
          <AdminPagination page={list.data.page} totalPages={list.data.totalPages} onPageChange={(next) => apply(filters, next)} />
        </div>
      ) : null}
    </div>
  );
}

function DeskSelect({
  label,
  value,
  onChange,
  options,
  block = false,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string | undefined) => void;
  options: { value: string; label: string }[];
  /** Labelled above, for the filter panel; otherwise labelled for screen readers only. */
  block?: boolean;
  disabled?: boolean;
}) {
  const select = (
    <select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || undefined)}
      aria-label={block ? undefined : label}
      className="h-9 cursor-pointer rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] font-normal text-admin-ink hover:border-admin-border-strong disabled:cursor-not-allowed disabled:text-admin-faint"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
  if (!block) return select;
  return (
    <label className="flex flex-col gap-1.5 text-xs font-medium text-admin-ink">
      {label}
      {select}
    </label>
  );
}

function TicketTable({ rows, loading }: { rows: StaffTicketRow[]; loading: boolean }) {
  const router = useRouter();
  return (
    // `relative` so the scroller also clips absolutely positioned content
    // (the screen-reader labels in cells), which would otherwise widen the page.
    <div className="relative overflow-x-auto rounded-[3px] border border-admin-border bg-admin-surface">
      <table className="w-full min-w-[56rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-admin-border bg-admin-raised text-left">
            {["Ticket", "Customer", "Priority", "Status", "Assigned", "SLA", "Updated"].map((header) => (
              <th key={header} scope="col" className="px-3 py-2.5 label-wide font-medium text-admin-muted">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            Array.from({ length: 6 }, (_, index) => (
              <tr key={index} className="border-b border-admin-border last:border-0">
                {Array.from({ length: 7 }, (__, cell) => (
                  <td key={cell} className="px-3 py-3.5">
                    <span className="block h-3 w-full max-w-28 animate-pulse rounded-[2px] bg-admin-border" />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-4 py-14 text-center">
                <p className="text-sm font-medium text-admin-ink">No tickets here</p>
                <p className="mx-auto mt-1.5 max-w-sm text-xs text-admin-muted">Try another view, or clear the filters.</p>
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const href = `/admin/support/ticket?id=${encodeURIComponent(row.id)}`;
              return (
                <tr
                  key={row.id}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("a")) return;
                    router.push(href);
                  }}
                  className={cn(
                    "cursor-pointer border-b border-admin-border align-top transition-colors last:border-0 hover:bg-admin-raised",
                    row.unread > 0 && "bg-copper-50/40",
                  )}
                >
                  <td className="max-w-[22rem] px-3 py-3">
                    <Link href={href} className="flex items-center gap-2 text-xs text-admin-muted hover:text-copper-700">
                      {row.unread > 0 ? (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-copper-600" aria-label={`${row.unread} unread`} />
                      ) : null}
                      <span className="font-medium tabular-nums text-admin-ink">{row.number}</span>
                      {row.channel === "chat" ? <span className="rounded-[3px] bg-admin-raised px-1 text-[0.625rem]">Chat</span> : null}
                      {row.escalationLevel > 0 ? (
                        <span className="rounded-[3px] bg-[#fbeaea] px-1 text-[0.625rem] text-[#a32424]">Esc. {row.escalationLevel}</span>
                      ) : null}
                    </Link>
                    <p className={cn("mt-1 truncate text-[0.8125rem] text-admin-ink", row.unread > 0 && "font-semibold")}>{row.subject}</p>
                    <p className="mt-0.5 truncate text-[0.6875rem] text-admin-muted">
                      {[row.category, row.subcategory, row.issue].filter(Boolean).join(" › ")}
                    </p>
                  </td>
                  <td className="px-3 py-3">
                    <p className="text-[0.8125rem] text-admin-ink">{row.customerName}</p>
                    <p className="max-w-[12rem] truncate text-[0.6875rem] text-admin-muted">{row.customerEmail}</p>
                  </td>
                  <td className="px-3 py-3">
                    <PriorityBadge priority={row.priority} />
                  </td>
                  <td className="px-3 py-3">
                    <TicketStatusBadge status={row.status} label={row.statusLabel} />
                  </td>
                  <td className="px-3 py-3">
                    <p className="text-[0.8125rem] text-admin-ink">{row.agent || <span className="text-admin-faint">Unassigned</span>}</p>
                    <p className="text-[0.6875rem] text-admin-muted">{row.team}</p>
                  </td>
                  <td className="px-3 py-3">
                    <SlaChip sla={row.sla} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-admin-muted">{formatAgo(row.updatedAt)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- insights */

function InsightsTab() {
  const [days, setDays] = useState(30);
  const dashboard = useAdminResource(() => getSupportDashboard(days), [days]);
  const data: SupportDashboard | null = dashboard.data;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-admin-muted">Requests raised in the last {days} days.</p>
        <div className="flex gap-1.5" role="group" aria-label="Period">
          {[7, 30, 90].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={days === value}
              onClick={() => setDays(value)}
              className={cn(
                "rounded-[3px] px-2.5 py-1.5 text-xs transition-colors",
                days === value ? "bg-admin-ink text-white" : "bg-admin-surface text-admin-muted ring-1 ring-inset ring-admin-border hover:text-admin-ink",
              )}
            >
              {value} days
            </button>
          ))}
        </div>
      </div>

      {dashboard.isLoading || !data ? (
        dashboard.error ? (
          <AdminCard>
            <div className="py-8 text-center">
              <p className="text-sm text-admin-ink">The figures didn&rsquo;t load.</p>
              <AdminButton size="sm" className="mt-3" onClick={() => void dashboard.reload()}>
                Try again
              </AdminButton>
            </div>
          </AdminCard>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="h-28 animate-pulse rounded-[3px] bg-admin-border/60" />
            ))}
          </div>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Kpi label="Raised" value={String(data.totals.createdInRange)} note={`in ${data.days} days`} />
            <Kpi
              label="First reply"
              value={data.avgFirstResponseMinutes === null ? "—" : formatDuration(data.avgFirstResponseMinutes)}
              note="average"
            />
            <Kpi
              label="Resolution"
              value={data.avgResolutionMinutes === null ? "—" : formatDuration(data.avgResolutionMinutes)}
              note="average"
            />
            <Kpi label="SLA met" value={data.slaCompliance === null ? "—" : `${data.slaCompliance}%`} note="of resolved requests" />
          </div>

          <AdminCard title="Requests over time" description="Raised each day">
            <TimeSeriesChart
              metric="orders"
              seriesName="Requests"
              points={data.overTime.map((point) => ({ label: point.date, orders: point.created, revenue: 0 }))}
            />
          </AdminCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <AdminCard title="By category">
              <BarList data={data.byCategory} />
            </AdminCard>
            <AdminCard title="By team">
              <BarList data={data.byTeam} />
            </AdminCard>
            <AdminCard title="By priority">
              <BarList data={data.byPriority} scale="ordinal" />
            </AdminCard>
            <AdminCard title="By channel">
              <BarList data={data.byChannel.map((row) => ({ ...row, label: row.label === "chat" ? "Live chat" : "Contact form" }))} />
            </AdminCard>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <AdminCard title="Agents" padded={false}>
              {data.byAgent.length === 0 ? (
                <p className="p-6 text-center text-xs text-admin-muted">No requests in this period.</p>
              ) : (
                <div className="relative overflow-x-auto">
                  <table className="w-full min-w-[28rem] text-left text-xs">
                    <thead className="border-b border-admin-border text-admin-muted">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Agent</th>
                        <th className="px-4 py-2.5 text-right font-medium">Handled</th>
                        <th className="px-4 py-2.5 text-right font-medium">Open</th>
                        <th className="px-4 py-2.5 text-right font-medium">Resolved</th>
                        <th className="px-4 py-2.5 text-right font-medium">Rating</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-admin-border">
                      {data.byAgent.map((row) => (
                        <tr key={row.label}>
                          <td className="px-4 py-2.5 text-admin-ink">{row.label}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{row.total}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{row.open}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{row.resolved}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{row.rating === null ? "—" : `${row.rating} ★`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </AdminCard>

            <AdminCard
              title="Customer satisfaction"
              description={
                data.satisfaction.count
                  ? `${data.satisfaction.count} ratings · ${data.satisfaction.positivePercent}% four stars or more`
                  : "No ratings in this period yet"
              }
            >
              <p className="text-3xl font-semibold tabular-nums text-admin-ink">
                {data.satisfaction.average === null ? "—" : data.satisfaction.average.toFixed(1)}
                <span className="ml-1 text-base font-normal text-admin-muted">/ 5</span>
              </p>
              <BarList className="mt-3" data={data.satisfaction.distribution} scale="ordinal" emptyMessage="No ratings yet." />
              {data.satisfaction.recent.length > 0 ? (
                <ul className="mt-4 flex flex-col gap-2.5 border-t border-admin-border pt-3">
                  {data.satisfaction.recent.map((row) => (
                    <li key={row.ticketId} className="text-xs">
                      <p className="text-[#b07500]" aria-label={`${row.rating} stars`}>
                        {"★".repeat(row.rating)}
                      </p>
                      <p className="mt-0.5 text-admin-ink">&ldquo;{row.comment}&rdquo;</p>
                      <Link href={`/admin/support/ticket?id=${encodeURIComponent(row.ticketId)}`} className="text-[0.6875rem] text-admin-muted hover:text-copper-700">
                        {row.ticketId} · {formatAgo(row.at)}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </AdminCard>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-[3px] border border-admin-border bg-admin-surface p-4">
      <p className="text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">{label}</p>
      <p className="mt-2 text-xl font-semibold tabular-nums text-admin-ink">{value}</p>
      <p className="mt-1 text-[0.6875rem] text-admin-faint">{note}</p>
    </div>
  );
}
