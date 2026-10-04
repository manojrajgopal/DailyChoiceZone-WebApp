"use client";

import Link from "next/link";
import { useState } from "react";
import { Download, Play, RefreshCw, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea, AdminToggle } from "@/components/admin/ui/AdminForm";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { FilterSelect, LogFooter, collectPages, downloadCsv, useUrlFilters } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import {
  adjustPoints,
  getLoyaltyMetrics,
  getLoyaltySettings,
  listLoyaltyBalances,
  listLoyaltyLedger,
  runLoyaltyHousekeeping,
  saveLoyaltySettings,
  type LoyaltySettings,
} from "@/services/admin/engagementAdminService";
import { toast } from "@/store/toastStore";

const KEYS = ["tab", "customer", "order", "kind"] as const;
const pts = (value: number) => value.toLocaleString("en-IN");

const KIND_OPTIONS = [
  { value: "", label: "Every kind" },
  { value: "earned", label: "Earned" },
  { value: "redeemed", label: "Spent" },
  { value: "restored", label: "Returned (cancelled order)" },
  { value: "reversed", label: "Taken back (refund/return)" },
  { value: "expired", label: "Expired" },
  { value: "manual_credit", label: "Added by staff" },
  { value: "manual_debit", label: "Removed by staff" },
];

/**
 * Reward points: what customers hold, every movement, manual adjustments
 * (with a reason, kept with who made them), and the programme's rules.
 *
 * Both lists are narrowed by ID (docs/id-lookup.md): a Customer ID, and on
 * the ledger an Order ID too — each matched exactly by the server. Names,
 * emails and reasons are shown, never searched.
 */
export function AdminLoyaltyView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize } = useUrlFilters(KEYS);
  const tab = filters.tab === "ledger" ? "ledger" : filters.tab === "settings" ? "settings" : "balances";
  const [adjusting, setAdjusting] = useState<{ id: string; name: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);

  const metrics = useAdminResource(() => getLoyaltyMetrics(30), []);
  const ledgerFilters = { customerId: filters.customer, orderId: filters.order, kind: filters.kind };
  const balances = useAdminResource(() => listLoyaltyBalances({ q: filters.customer, page, pageSize }), [filters.customer, page, pageSize], { enabled: tab === "balances" });
  const ledger = useAdminResource(() => listLoyaltyLedger({ ...ledgerFilters, page, pageSize }), [filters.customer, filters.order, filters.kind, page, pageSize], { enabled: tab === "ledger" });
  const m = metrics.data;

  const housekeeping = async () => {
    setRunning(true);
    try {
      const result = await runLoyaltyHousekeeping();
      toast.success(`Released ${result.released} pending batches; expired ${pts(result.expiredPoints)} points.`);
      await Promise.all([metrics.reload(), tab === "balances" ? balances.reload() : ledger.reload()]);
    } catch (error) {
      toast.error(problem(error, "That didn't run."));
    } finally {
      setRunning(false);
    }
  };

  const exportLedger = async () => {
    setExporting(true);
    try {
      const { rows, truncated } = await collectPages((p) => listLoyaltyLedger({ ...ledgerFilters, page: p, pageSize: 100 }));
      downloadCsv(`reward-points-${new Date().toISOString().slice(0, 10)}.csv`,
        ["When", "Customer", "Email", "What", "Points", "Balance after", "Order", "Reason", "By"],
        rows.map((r) => [formatDateTime(r.createdAt), r.customer.name, r.customer.email, r.label, r.points, r.balanceAfter, r.orderId ?? "", r.reason, r.by ?? ""]));
      toast.success(truncated ? `Exported the newest ${rows.length} entries.` : `Exported ${rows.length} entries.`);
    } catch (error) {
      toast.error(problem(error, "The export didn't work."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="Reward points"
        description="Points customers earn on delivered orders and spend at checkout. Every change is in the ledger."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Reward points" }]}
        actions={
          <>
            <AdminButton size="sm" onClick={() => void housekeeping()} loading={running}>
              {running ? null : <Play className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Release &amp; expire now
            </AdminButton>
            {tab === "ledger" ? (
              <AdminButton size="sm" onClick={() => void exportLedger()} loading={exporting}>
                {exporting ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
                Export CSV
              </AdminButton>
            ) : null}
            <AdminButton size="sm" onClick={() => void Promise.all([metrics.reload(), balances.reload(), ledger.reload()])}>
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Refresh
            </AdminButton>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile label="Spendable points" value={m ? pts(m.outstanding) : null} hint={m ? `Worth ₹${m.outstandingValue.toLocaleString("en-IN")}` : undefined} />
        <Tile label="Pending" value={m ? pts(m.pending) : null} hint="Waiting for return windows" />
        <Tile label="Customers with points" value={m ? pts(m.customersWithPoints) : null} />
        <Tile label="Earned · 30 days" value={m ? pts(m.period.earned ?? 0) : null} tone="good" />
        <Tile label="Spent · 30 days" value={m ? pts(-(m.period.redeemed ?? 0)) : null} />
        <Tile label="Expiring in 30 days" value={m ? pts(m.expiringIn30Days) : null} tone={m?.expiringIn30Days ? "warn" : undefined}
          hint={m?.debt ? `${pts(m.debt)} points owed back` : undefined} />
      </div>

      <div className="mb-4 inline-flex rounded-[3px] border border-admin-border bg-admin-surface p-0.5" role="tablist" aria-label="View">
        {(["balances", "ledger", "settings"] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value}
            onClick={() => setFilters({ tab: value === "balances" ? "" : value, kind: "", order: "" })}
            className={cn("rounded-[2px] px-3.5 py-1.5 text-xs font-medium", tab === value ? "bg-admin-ink text-white" : "text-admin-muted hover:text-admin-ink")}>
            {value === "balances" ? "Customers" : value === "ledger" ? "Ledger" : "Rules"}
          </button>
        ))}
      </div>

      {tab === "settings" ? (
        <LoyaltySettingsCard />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <IdFilter entity="customer" value={filters.customer} onChange={(customer) => setFilters({ customer })} className="w-56" />
            {tab === "ledger" ? (
              <>
                <IdFilter entity="order" value={filters.order} onChange={(order) => setFilters({ order })} className="w-56" />
                <FilterSelect label="Kind" value={filters.kind} onChange={(kind) => setFilters({ kind })} options={KIND_OPTIONS} />
              </>
            ) : null}
            {filters.customer || filters.order || filters.kind ? (
              <AdminButton size="sm" variant="ghost" onClick={() => setFilters({ customer: "", order: "", kind: "" })}>
                <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Clear filters
              </AdminButton>
            ) : null}
          </div>

          {tab === "balances" ? (
            <AdminCard padded={false}>
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[52rem] text-left text-xs">
                  <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                    <tr>
                      <th className={TH}>Customer</th>
                      <th className={cn(TH, "text-right")}>Spendable</th>
                      <th className={cn(TH, "text-right")}>Pending</th>
                      <th className={cn(TH, "text-right")}>Earned</th>
                      <th className={cn(TH, "text-right")}>Spent</th>
                      <th className={cn(TH, "text-right")}>Expired</th>
                      <th className={cn(TH, "text-right")}>Taken back</th>
                      <th className={cn(TH, "text-right")}><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-admin-border">
                    <TableState columns={8} loading={balances.isLoading && !balances.data} failed={Boolean(balances.error && !balances.data)}
                      empty={Boolean(balances.data && balances.data.items.length === 0)} onRetry={() => void balances.reload()}
                      title={filters.customer ? "That customer has no points account" : "No points yet"} hint="Customers appear once they earn or are given points." />
                    {balances.data?.items.map((row) => (
                      <tr key={row.customer.id} className="hover:bg-admin-raised">
                        <td className={TD}>
                          <Link href={`/admin/customers/detail?id=${encodeURIComponent(row.customer.id)}`} className="block font-medium text-admin-ink hover:text-copper-700">{row.customer.name}</Link>
                          <span className="block text-admin-muted">{row.customer.email}</span>
                        </td>
                        <td className={cn(TD, "text-right font-medium tabular-nums", row.available < 0 ? "text-[#a12b2b]" : "text-admin-ink")}>{pts(row.available)}</td>
                        <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{pts(row.pending)}</td>
                        <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{pts(row.lifetimeEarned)}</td>
                        <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{pts(row.lifetimeRedeemed)}</td>
                        <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{pts(row.lifetimeExpired)}</td>
                        <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{pts(row.lifetimeReversed)}</td>
                        <td className={cn(TD, "whitespace-nowrap text-right")}>
                          <AdminButton size="sm" variant="ghost" onClick={() => setFilters({ tab: "ledger", customer: row.customer.id })}>Ledger</AdminButton>
                          <AdminButton size="sm" variant="ghost" onClick={() => setAdjusting({ id: row.customer.id, name: row.customer.name })}>Adjust</AdminButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminCard>
          ) : (
            <AdminCard padded={false}>
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[56rem] text-left text-xs">
                  <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
                    <tr>
                      <th className={TH}>When</th>
                      <th className={TH}>Customer</th>
                      <th className={TH}>What</th>
                      <th className={cn(TH, "text-right")}>Points</th>
                      <th className={cn(TH, "text-right")}>Spendable after</th>
                      <th className={TH}>Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-admin-border">
                    <TableState columns={6} loading={ledger.isLoading && !ledger.data} failed={Boolean(ledger.error && !ledger.data)}
                      empty={Boolean(ledger.data && ledger.data.items.length === 0)} onRetry={() => void ledger.reload()}
                      title="No entries" hint="Points movements appear here as they happen." />
                    {ledger.data?.items.map((row) => (
                      <tr key={row.id} className="align-top hover:bg-admin-raised">
                        <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.createdAt)}</td>
                        <td className={TD}>
                          <span className="block text-admin-ink">{row.customer.name}</span>
                          <span className="block text-admin-muted">{row.customer.email}</span>
                        </td>
                        <td className={cn(TD, "text-admin-ink")}>
                          {row.label}
                          {row.kind === "earned" && row.availableAt ? <span className="block text-admin-muted">spendable {formatDateTime(row.availableAt)}</span> : null}
                        </td>
                        <td className={cn(TD, "text-right tabular-nums", row.points > 0 ? "text-[#0a6b0a]" : "text-admin-ink")}>
                          {row.points > 0 ? "+" : "−"}{pts(Math.abs(row.points))}
                        </td>
                        <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{pts(row.balanceAfter)}</td>
                        <td className={cn(TD, "max-w-[18rem] text-admin-muted")}>
                          {row.reason}{row.orderId ? ` · ${row.orderId}` : ""}
                          {row.by ? <span className="block text-admin-faint">by {row.by}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AdminCard>
          )}

          {(tab === "balances" ? balances.data : ledger.data) ? (
            <LogFooter
              page={(tab === "balances" ? balances.data : ledger.data)!.pagination.page}
              pageSize={pageSize}
              total={(tab === "balances" ? balances.data : ledger.data)!.pagination.total}
              totalPages={(tab === "balances" ? balances.data : ledger.data)!.pagination.total_pages}
              onPage={setPage}
              onPageSize={setPageSize}
            />
          ) : null}
        </>
      )}

      <AdjustDialog customer={adjusting} onClose={() => setAdjusting(null)}
        onDone={() => void Promise.all([metrics.reload(), balances.reload()])} />
    </div>
  );
}

function AdjustDialog({ customer, onClose, onDone }: { customer: { id: string; name: string } | null; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<"manual_credit" | "manual_debit">("manual_credit");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState(() => Math.random().toString(36).slice(2));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!customer) return;
    setBusy(true);
    try {
      await adjustPoints(customer.id, { kind, points: Math.floor(Number(points)), reason, requestKey });
      toast.success(kind === "manual_credit" ? "Points added." : "Points removed.");
      setPoints("");
      setReason("");
      setRequestKey(Math.random().toString(36).slice(2));
      onClose();
      onDone();
    } catch (error) {
      toast.error(problem(error, "The points weren't changed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={customer !== null} onOpenChange={(open) => !open && onClose()} title={`Adjust points — ${customer?.name ?? ""}`} className="max-w-md"
      description="Added points are spendable at once and expire like earned points. The reason is kept with your name.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <AdminSelect label="Change" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}
          options={[{ value: "manual_credit", label: "Add points" }, { value: "manual_debit", label: "Remove points" }]} />
        <AdminInput label="Points" type="number" min={1} step={1} value={points} onChange={(e) => setPoints(e.target.value)} required />
        <AdminTextarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} required />
        <div>
          <AdminButton type="submit" variant="primary" loading={busy} disabled={!points || reason.trim().length < 5}>Apply</AdminButton>
        </div>
      </form>
    </Modal>
  );
}

function LoyaltySettingsCard() {
  const loaded = useAdminResource(getLoyaltySettings, []);
  const [draft, setDraft] = useState<LoyaltySettings | null>(null);
  const [lists, setLists] = useState<{ eligible: string; excludedCategories: string; excludedProducts: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? loaded.data;
  const text = lists ?? (loaded.data ? {
    eligible: loaded.data.eligibleCategories.join(", "),
    excludedCategories: loaded.data.excludedCategories.join(", "),
    excludedProducts: loaded.data.excludedProducts.join(", "),
  } : null);

  const patch = (next: Partial<LoyaltySettings>) => value && setDraft({ ...value, ...next });
  const num = (key: keyof LoyaltySettings) => (event: React.ChangeEvent<HTMLInputElement>) =>
    patch({ [key]: event.target.value === "" ? 0 : Number(event.target.value) } as Partial<LoyaltySettings>);
  const split = (raw: string) => raw.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);

  const save = async () => {
    if (!value || !text) return;
    setSaving(true);
    try {
      await saveLoyaltySettings({ ...value, eligibleCategories: split(text.eligible), excludedCategories: split(text.excludedCategories), excludedProducts: split(text.excludedProducts) });
      toast.success("Reward points rules saved.");
      setDraft(null);
      setLists(null);
      await loaded.reload();
    } catch (error) {
      toast.error(problem(error, "The rules weren't saved."));
    } finally {
      setSaving(false);
    }
  };

  if (!value || !text) {
    return <AdminCard><p className="text-sm text-admin-muted">{loaded.error ? "The rules didn't load." : "Loading…"}</p></AdminCard>;
  }

  return (
    <AdminCard title="Rules" description="Changes apply to points earned and spent from now on; points already earned keep their dates.">
      <div className="flex max-w-3xl flex-col gap-6">
        <AdminToggle label="Reward points programme" checked={value.enabled} onChange={(enabled) => patch({ enabled })}
          description="When off, no new points are earned or spent. Balances are kept." />
        <div>
          <p className="mb-2 text-xs font-medium text-admin-ink">Earning</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <AdminInput label="Points per ₹100 spent" type="number" min={0} value={value.pointsPer100} onChange={num("pointsPer100")} />
            <AdminInput label="Spendable after (days)" type="number" min={0} value={value.pendingDays ?? ""}
              onChange={(e) => patch({ pendingDays: e.target.value === "" ? null : Number(e.target.value) })} hint="Blank: the return window" />
            <AdminInput label="Member multiplier" type="number" min={1} max={10} step="0.1" value={value.memberMultiplier} onChange={num("memberMultiplier")} />
          </div>
          <div className="mt-3 flex flex-col gap-3">
            <AdminToggle label="Earn on the price before tax" checked={value.excludeTax} onChange={(excludeTax) => patch({ excludeTax })} />
            <AdminToggle label="No points on what gift cards, store credit or points paid" checked={value.excludeTenderPaid} onChange={(excludeTenderPaid) => patch({ excludeTenderPaid })} />
            <AdminToggle label="No points on discounted items" checked={value.excludeDiscountedItems} onChange={(excludeDiscountedItems) => patch({ excludeDiscountedItems })} />
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            <AdminTextarea label="Only these categories earn" rows={2} value={text.eligible} hint="Category slugs or ids; blank = all"
              onChange={(e) => { setLists({ ...text, eligible: e.target.value }); patch({}); }} />
            <AdminTextarea label="Categories that never earn" rows={2} value={text.excludedCategories}
              onChange={(e) => { setLists({ ...text, excludedCategories: e.target.value }); patch({}); }} />
            <AdminTextarea label="Products that never earn" rows={2} value={text.excludedProducts} hint="Product ids, e.g. PRD012"
              onChange={(e) => { setLists({ ...text, excludedProducts: e.target.value }); patch({}); }} />
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-admin-ink">Spending</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <AdminInput label="Points" type="number" min={1} value={value.redeemPoints} onChange={num("redeemPoints")} />
            <AdminInput label="… are worth (₹)" type="number" min={1} value={value.redeemValue} onChange={num("redeemValue")} />
            <AdminInput label="Minimum to spend" type="number" min={0} value={value.minRedeemPoints} onChange={num("minRedeemPoints")} />
            <AdminInput label="Most points per order" type="number" min={0} value={value.maxPointsPerOrder} onChange={num("maxPointsPerOrder")} hint="0: no cap" />
            <AdminInput label="Most of an order payable (%)" type="number" min={1} max={100} value={value.maxOrderPercent} onChange={num("maxOrderPercent")} />
          </div>
          <div className="mt-3 flex flex-col gap-3">
            <AdminToggle label="Points can be used with a coupon" checked={value.allowWithCoupons} onChange={(allowWithCoupons) => patch({ allowWithCoupons })} />
            <AdminToggle label="Points can be used with a gift card" checked={value.allowWithGiftCards} onChange={(allowWithGiftCards) => patch({ allowWithGiftCards })} />
            <AdminToggle label="Points can be used with store credit" checked={value.allowWithStoreCredit} onChange={(allowWithStoreCredit) => patch({ allowWithStoreCredit })} />
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-admin-ink">Expiry</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <AdminInput label="Points expire after (months)" type="number" min={0} max={120} value={value.expiryMonths} onChange={num("expiryMonths")} hint="0: never" />
            <AdminInput label="Warn this many days before" type="number" min={0} max={90} value={value.expiryWarningDays} onChange={num("expiryWarningDays")} hint="0: no reminder email" />
          </div>
        </div>
        <div className="flex gap-2">
          <AdminButton variant="primary" onClick={() => void save()} loading={saving} disabled={!draft}>Save rules</AdminButton>
          {draft ? <AdminButton variant="ghost" onClick={() => { setDraft(null); setLists(null); }}>Discard changes</AdminButton> : null}
        </div>
      </div>
    </AdminCard>
  );
}
