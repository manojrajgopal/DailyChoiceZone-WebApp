"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus, RefreshCw, Trash2, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminToggle } from "@/components/admin/ui/AdminForm";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { FilterSelect, LogFooter, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";
import {
  abandonedCartMetrics,
  getAbandonedCartSettings,
  listAbandonedCarts,
  saveAbandonedCartSettings,
  type AbandonedCart,
  type AbandonedCartSettings,
} from "@/services/admin/operationsAdminService";
import { toast } from "@/store/toastStore";

import { Badge, TD, TH, TableState, Tile, problem } from "./shared";

const KEYS = ["status", "q", "days"] as const;

const STATUS: Record<AbandonedCart["status"], { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  abandoned: { label: "Abandoned", tone: "amber" },
  recovered: { label: "Recovered", tone: "green" },
  converted: { label: "Ordered", tone: "green" },
  expired: { label: "Expired", tone: "grey" },
  emptied: { label: "Emptied", tone: "grey" },
  active: { label: "Active", tone: "grey" },
};

function duration(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} minutes`;
}

/**
 * Bags signed-in customers left behind, the reminders sent about them, and
 * what came back as orders. Guest bags live only in the shopper's browser, so
 * they can't be tracked here.
 *
 * One customer's carts are found by Customer ID (docs/id-lookup.md), matched
 * exactly; names and emails are shown, never searched.
 */
export function AdminAbandonedCartsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const days = filters.days || "30";
  const metrics = useAdminResource(() => abandonedCartMetrics(days), [days]);
  const carts = useAdminResource(
    () => listAbandonedCarts({ status: filters.status, q: filters.q, days: filters.days, page, pageSize }),
    [filters, page, pageSize],
  );
  const m = metrics.data;
  const data = carts.data;
  const filtered = Boolean(filters.status || filters.q || filters.days);

  return (
    <div>
      <AdminPageHeader
        title="Abandoned carts"
        description="Bags left without checking out, the reminders sent, and the orders that came back."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Abandoned carts" }]}
        actions={
          <AdminButton size="sm" onClick={() => void Promise.all([metrics.reload(), carts.reload()])} loading={carts.isRefreshing}>
            {carts.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Refresh
          </AdminButton>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label={`Abandoned · ${days} days`} value={m ? m.abandoned.toLocaleString("en-IN") : null} />
        <Tile label="Waiting now" value={m ? m.openNow.toLocaleString("en-IN") : null} tone={m?.openNow ? "warn" : undefined} />
        <Tile label="Reminded" value={m ? m.reminded.toLocaleString("en-IN") : null} />
        <Tile label="Recovered" value={m ? m.recovered.toLocaleString("en-IN") : null} tone="good" />
        <Tile label="Recovery rate" value={m ? (m.recoveryRate === null ? "—" : `${m.recoveryRate}%`) : null} />
        <Tile
          label="Recovered revenue"
          value={m ? formatPrice(m.recoveredRevenue) : null}
          tone="good"
          hint={m ? `${formatPrice(m.potentialRevenue)} still in abandoned bags` : undefined}
        />
      </div>

      <StatusTabs
        label="Filter carts by status"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "All abandoned" },
          { value: "abandoned", label: "Waiting", count: m?.byStatus.abandoned },
          { value: "recovered", label: "Recovered", count: m?.byStatus.recovered },
          { value: "expired", label: "Expired", count: m?.byStatus.expired },
          { value: "emptied", label: "Emptied", count: m?.byStatus.emptied },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <IdFilter entity="customer" value={filters.q} onChange={(q) => setFilters({ q })} className="w-56" />
        <FilterSelect
          label="Abandoned"
          value={filters.days}
          onChange={(value) => setFilters({ days: value })}
          options={[
            { value: "", label: "Any time" },
            { value: "7", label: "Last 7 days" },
            { value: "30", label: "Last 30 days" },
            { value: "90", label: "Last 90 days" },
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
          <table className={cn("w-full min-w-[58rem] text-left text-xs", carts.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Customer</th>
                <th className={TH}>Bag</th>
                <th className={cn(TH, "text-right")}>Value</th>
                <th className={TH}>Abandoned</th>
                <th className={TH}>Reminders</th>
                <th className={TH}>Status</th>
                <th className={TH}>Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={7}
                loading={carts.isLoading && !data}
                failed={Boolean(carts.error && !data)}
                empty={Boolean(data && data.items.length === 0)}
                onRetry={() => void carts.reload()}
                title={filtered ? "No carts match" : "No abandoned carts"}
                hint={filtered ? "Try a different filter or Customer ID." : "Bags appear here once they've been left untouched for the time set below."}
              />
              {data?.items.map((row) => {
                const status = STATUS[row.status] ?? STATUS.active;
                return (
                  <tr key={row.id} className="align-top hover:bg-admin-raised">
                    <td className={TD}>
                      {row.customer ? (
                        <>
                          <Link href={`/admin/customers/detail?id=${encodeURIComponent(row.customer.id)}`} className="block font-medium text-admin-ink hover:text-copper-700">
                            {row.customer.name || "—"}
                          </Link>
                          <span className="block text-admin-muted">{row.customer.email}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={cn(TD, "max-w-[18rem]")}>
                      <span className="block text-admin-ink">
                        {row.itemCount} {row.itemCount === 1 ? "item" : "items"}
                      </span>
                      <span className="line-clamp-2 text-admin-muted">{row.items.map((line) => `${line.name} × ${line.quantity}`).join(", ")}</span>
                    </td>
                    <td className={cn(TD, "text-right tabular-nums text-admin-ink")}>{formatPrice(row.cartValue)}</td>
                    <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{row.abandonedAt ? formatDateTime(row.abandonedAt) : "—"}</td>
                    <td className={cn(TD, "text-admin-muted")}>
                      {row.remindersSent ? `${row.remindersSent} sent` : "None yet"}
                      {row.clickedAt ? <span className="block text-admin-ink">Link opened {formatDateTime(row.clickedAt)}</span> : null}
                    </td>
                    <td className={TD}>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                    <td className={cn(TD, "text-admin-muted")}>
                      {row.status === "recovered" && row.recoveredOrderId ? (
                        <Link href={`/admin/orders/detail?id=${encodeURIComponent(row.recoveredOrderId)}`} className="text-admin-ink hover:text-copper-700">
                          Order · {row.recoveredValue !== null ? formatPrice(row.recoveredValue) : ""}
                        </Link>
                      ) : (
                        "—"
                      )}
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

      <ReminderSettings />
    </div>
  );
}

function ReminderSettings() {
  const loaded = useAdminResource(getAbandonedCartSettings, []);
  const [draft, setDraft] = useState<AbandonedCartSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? loaded.data;

  const patch = (next: Partial<AbandonedCartSettings>) => value && setDraft({ ...value, ...next });

  const save = async () => {
    if (!value) return;
    setSaving(true);
    try {
      await saveAbandonedCartSettings(value);
      toast.success("Abandoned-cart settings saved.");
      setDraft(null);
      await loaded.reload();
    } catch (error) {
      toast.error(problem(error, "The settings weren't saved. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminCard
      title="Reminders"
      description="Emails go only to customers who haven't turned off bag reminders in their email preferences."
      className="mt-8"
    >
      {!value ? (
        <p className="text-sm text-admin-muted">{loaded.error ? "The settings didn't load." : "Loading…"}</p>
      ) : (
        <div className="flex max-w-2xl flex-col gap-5">
          <AdminToggle
            label="Track abandoned carts and send reminders"
            description="When off, nothing is marked abandoned and no reminder is sent."
            checked={value.enabled}
            onChange={(enabled) => patch({ enabled })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <AdminInput
              label="A bag counts as abandoned after (minutes)"
              type="number"
              min={15}
              max={10080}
              value={value.abandonAfterMinutes}
              onChange={(event) => patch({ abandonAfterMinutes: Number(event.target.value) })}
              hint={`Untouched for ${duration(value.abandonAfterMinutes || 0)}.`}
            />
            <AdminInput
              label="Stop tracking after (days)"
              type="number"
              min={1}
              max={90}
              value={value.expireAfterDays}
              onChange={(event) => patch({ expireAfterDays: Number(event.target.value) })}
            />
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-admin-ink">Reminder emails</p>
            <ol className="flex flex-col gap-2">
              {value.reminders.map((stage, index) => (
                <li key={index} className="flex items-end gap-2">
                  <AdminInput
                    label={`Reminder ${index + 1} — minutes after abandoning`}
                    type="number"
                    min={30}
                    max={20160}
                    value={stage.afterMinutes}
                    onChange={(event) =>
                      patch({
                        reminders: value.reminders.map((entry, at) => (at === index ? { afterMinutes: Number(event.target.value) } : entry)),
                      })
                    }
                    hint={duration(stage.afterMinutes || 0)}
                    className="flex-1"
                  />
                  <AdminButton
                    size="sm"
                    variant="ghost"
                    className="mb-5"
                    onClick={() => patch({ reminders: value.reminders.filter((_, at) => at !== index) })}
                    aria-label={`Remove reminder ${index + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </AdminButton>
                </li>
              ))}
            </ol>
            {value.reminders.length < 3 ? (
              <AdminButton
                size="sm"
                className="mt-2"
                onClick={() =>
                  patch({
                    reminders: [...value.reminders, { afterMinutes: (value.reminders.at(-1)?.afterMinutes ?? 0) + 1440 || 1440 }],
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Add a reminder
              </AdminButton>
            ) : null}
          </div>

          <div className="flex gap-2">
            <AdminButton variant="primary" onClick={() => void save()} loading={saving} disabled={!draft}>
              Save settings
            </AdminButton>
            {draft ? (
              <AdminButton variant="ghost" onClick={() => setDraft(null)}>
                Discard changes
              </AdminButton>
            ) : null}
          </div>
        </div>
      )}
    </AdminCard>
  );
}
