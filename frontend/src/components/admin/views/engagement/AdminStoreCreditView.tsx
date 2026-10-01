"use client";

import Link from "next/link";
import { useState } from "react";
import { RefreshCw, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect } from "@/components/admin/ui/AdminForm";
import { LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { adjustStoreCredit, getCreditLedger, listStoreCredit } from "@/services/admin/engagementAdminService";
import { toast } from "@/store/toastStore";

const KEYS = ["view", "q"] as const;

const rupees = (value: number) =>
  `₹${value.toLocaleString("en-IN", { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const KINDS = [
  { value: "grant", label: "Add credit" },
  { value: "goodwill", label: "Add goodwill credit" },
  { value: "promotion", label: "Add promotional credit" },
  { value: "revoke", label: "Remove credit" },
];

/**
 * Store credit: customers' balances, each one's ledger, and adding or
 * removing credit. Every change needs a reason and is kept, with who made it;
 * a balance never changes without an entry.
 */
export function AdminStoreCreditView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const [openId, setOpenId] = useState<string | null>(null);
  const searching = Boolean(filters.q);

  const list = useAdminResource(
    () => listStoreCredit({ q: filters.q, withBalance: filters.view !== "all" && !searching, page, pageSize }),
    [filters, page, pageSize],
  );
  const data = list.data;

  return (
    <div>
      <AdminPageHeader
        title="Store credit"
        description="Credit customers can spend at checkout — from refunds, goodwill or promotions."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Store credit" }]}
        actions={
          <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
            {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Refresh
          </AdminButton>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile label="Credit outstanding" value={data ? rupees(data.outstanding) : null} hint="Across every customer" />
        <Tile label={searching ? "Customers found" : "Customers with credit"} value={data ? String(data.pagination.total) : null} />
      </div>

      <StatusTabs
        label="Which customers"
        value={filters.view}
        onChange={(view) => setFilters({ view })}
        tabs={[{ value: "", label: "With a balance" }, { value: "all", label: "Every credit account" }]}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch label="Find a customer" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Name, email or customer ID — to add credit to anyone" />
        {filters.q || filters.view ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Clear
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[48rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Customer</th>
                <th className={cn(TH, "text-right")}>Balance</th>
                <th className={cn(TH, "text-right")}>Credited</th>
                <th className={cn(TH, "text-right")}>Spent</th>
                <th className={TH}>Last change</th>
                <th className={cn(TH, "text-right")}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={6} loading={list.isLoading && !data} failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)} onRetry={() => void list.reload()}
                title={searching ? "No customers match" : "No customer has store credit"}
                hint={searching ? "Check the spelling, or search by email." : "Search for a customer to add credit to their account."} />
              {data?.items.map((row) => (
                <tr key={row.customer.id} className="hover:bg-admin-raised">
                  <td className={TD}>
                    <Link href={`/admin/customers/detail?id=${encodeURIComponent(row.customer.id)}`} className="block font-medium text-admin-ink hover:text-copper-700">
                      {row.customer.name}
                    </Link>
                    <span className="block text-admin-muted">{row.customer.email}</span>
                  </td>
                  <td className={cn(TD, "text-right font-medium tabular-nums text-admin-ink")}>{rupees(row.balance)}</td>
                  <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{rupees(row.lifetimeCredited)}</td>
                  <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{rupees(row.lifetimeSpent)}</td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{row.updatedAt ? formatDateTime(row.updatedAt) : "—"}</td>
                  <td className={cn(TD, "text-right")}>
                    <AdminButton size="sm" variant="ghost" onClick={() => setOpenId(row.customer.id)}>Ledger & adjust</AdminButton>
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

      <LedgerDialog customerId={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />
    </div>
  );
}

function LedgerDialog({ customerId, onClose, onChanged }: { customerId: string | null; onClose: () => void; onChanged: () => void }) {
  const [page, setPage] = useState(1);
  const ledger = useAdminResource(() => getCreditLedger(customerId ?? "", page), [customerId, page], { enabled: customerId !== null });
  const data = ledger.data;
  const [kind, setKind] = useState("grant");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // A fresh key per form, so a double-click posts once.
  const [requestKey, setRequestKey] = useState(() => Math.random().toString(36).slice(2));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!customerId) return;
    setBusy(true);
    try {
      await adjustStoreCredit(customerId, { kind, amount: Number(amount), reason, requestKey });
      toast.success(kind === "revoke" ? "Credit removed." : "Credit added.");
      setAmount("");
      setReason("");
      setRequestKey(Math.random().toString(36).slice(2));
      await ledger.reload();
      onChanged();
    } catch (error) {
      toast.error(problem(error, "The change wasn't made."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={customerId !== null} onOpenChange={(open) => { if (!open) { onClose(); setPage(1); } }}
      title={data ? `Store credit — ${data.customer.name}` : "Store credit"} className="max-w-2xl">
      {!data ? (
        <p className="text-sm text-ink-500">{ledger.error ? problem(ledger.error, "This didn't load.") : "Loading…"}</p>
      ) : (
        <div className="flex flex-col gap-5 text-xs">
          <p className="text-sm text-admin-ink">
            Balance <strong className="tabular-nums">{rupees(data.balance)}</strong>
            <span className="text-admin-muted"> · credited {rupees(data.lifetimeCredited)} · spent {rupees(data.lifetimeSpent)}</span>
          </p>

          <form onSubmit={submit} className="grid gap-3 rounded-[3px] border border-admin-border p-3 sm:grid-cols-[12rem_8rem_1fr_auto] sm:items-end">
            <AdminSelect label="Change" value={kind} onChange={(e) => setKind(e.target.value)} options={KINDS} />
            <AdminInput label="Amount" type="number" min={0.01} step="0.01" prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            <AdminInput label="Reason (the customer may see it)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required />
            <AdminButton type="submit" variant="primary" loading={busy} disabled={!amount || reason.trim().length < 5}>Apply</AdminButton>
          </form>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left">
              <thead className="text-admin-muted">
                <tr><th className="py-1.5 pr-3 font-medium">When</th><th className="py-1.5 pr-3 font-medium">What</th><th className="py-1.5 pr-3 text-right font-medium">Amount</th><th className="py-1.5 text-right font-medium">Balance</th></tr>
              </thead>
              <tbody className="divide-y divide-admin-border">
                {data.items.length === 0 ? (
                  <tr><td colSpan={4} className="py-4 text-center text-admin-muted">No store credit activity yet.</td></tr>
                ) : data.items.map((entry) => (
                  <tr key={entry.id}>
                    <td className="py-1.5 pr-3 whitespace-nowrap text-admin-muted">{formatDateTime(entry.createdAt)}</td>
                    <td className="py-1.5 pr-3">
                      <span className="text-admin-ink">{entry.label}</span>
                      {entry.orderId ? <span className="text-admin-muted"> · {entry.orderId}</span> : null}
                      {entry.reason ? <span className="block text-admin-muted">{entry.reason}</span> : null}
                      {entry.by ? <span className="block text-admin-faint">by {entry.by}</span> : null}
                    </td>
                    <td className={cn("py-1.5 pr-3 text-right tabular-nums", entry.amount > 0 ? "text-[#0a6b0a]" : "text-admin-ink")}>
                      {entry.amount > 0 ? "+" : "−"}{rupees(Math.abs(entry.amount))}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{rupees(entry.balanceAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.pagination.total_pages > 1 ? (
            <div className="flex justify-between">
              <AdminButton size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</AdminButton>
              <AdminButton size="sm" variant="ghost" disabled={page >= data.pagination.total_pages} onClick={() => setPage(page + 1)}>Older</AdminButton>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
