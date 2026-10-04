"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { IdKindFilter } from "@/components/admin/ui/IdKindFilter";
import { LogFooter, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { rupees } from "@/components/admin/views/growth/shared";
import { Badge, TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import {
  type AdminReferral,
  type ReferralSettings,
  type ReferralStatus,
  decideReferral,
  getReferralMetrics,
  getReferralSettings,
  listReferrals,
  saveReferralSettings,
} from "@/services/admin/growthAdminService";
import { toast } from "@/store/toastStore";

const STATUS: Record<ReferralStatus, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  pending: { label: "Waiting for first order", tone: "grey" },
  review: { label: "Held for review", tone: "amber" },
  rewarded: { label: "Rewarded", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  reversed: { label: "Reversed", tone: "red" },
  expired: { label: "Expired", tone: "grey" },
};

const KEYS = ["status", "q", "by"] as const;

/** The list box takes a referral code or a Customer ID (referrer or friend), exactly — never a name or email. */
const FIND_BY = ["referral_code", "customer"] as const;
type FindBy = (typeof FIND_BY)[number];

/** The referral programme: who referred whom, rewards paid, and referrals held for a person to check. */
export function AdminReferralsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize } = useUrlFilters(KEYS);
  const list = useAdminResource(() => listReferrals({ status: filters.status, q: filters.q, page, pageSize }), [filters, page, pageSize]);
  const metrics = useAdminResource(() => getReferralMetrics(30), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deciding, setDeciding] = useState<{ row: AdminReferral; action: "approve" | "reject" } | null>(null);
  const data = list.data;
  const m = metrics.data;
  const findBy: FindBy = filters.by === "customer" ? "customer" : "referral_code";
  const reward = (row: AdminReferral, value: number) => (row.rewardType === "points" ? `${value.toLocaleString("en-IN")} pts` : rupees(value));

  return (
    <div>
      <AdminPageHeader
        title="Referrals"
        description="Customers inviting friends. Rewards are paid by the server only after the friend's first qualifying order, once."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Referrals" }]}
        actions={
          <div className="flex gap-2">
            <AdminButton size="sm" onClick={() => { void list.reload(); void metrics.reload(); }} loading={list.isRefreshing}>
              {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
            </AdminButton>
            <AdminButton size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Programme settings
            </AdminButton>
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Tile label="Sign-ups (30 days)" value={m ? String(m.signups) : null} />
        <Tile label="Rewarded (30 days)" value={m ? String(m.rewarded) : null} hint={m?.conversion !== null && m ? `${m.conversion}% of sign-ups` : undefined} />
        <Tile label="Credit paid" value={m ? rupees(m.creditPaid) : null} hint={m && m.pointsPaid ? `${m.pointsPaid.toLocaleString("en-IN")} points too` : undefined} />
        <Tile label="Revenue from first orders" value={m ? rupees(m.qualifyingRevenue) : null} />
        <Tile label="Held for review" value={m ? String(m.inReview) : null} tone={m?.inReview ? "warn" : undefined} />
      </div>

      <StatusTabs label="Which referrals" value={filters.status} onChange={(status) => setFilters({ status })}
        tabs={[{ value: "", label: "All" }, ...(Object.keys(STATUS) as ReferralStatus[]).map((s) => ({ value: s, label: STATUS[s].label, count: data?.counts[s] }))]} />
      <div className="mb-3">
        <IdKindFilter kinds={FIND_BY} entity={findBy} value={filters.q}
          onChange={({ entity, id }) => setFilters({ by: entity === "referral_code" ? "" : entity, q: id })} />
      </div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[60rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr><th className={TH}>Referrer</th><th className={TH}>Friend</th><th className={TH}>Status</th><th className={TH}>First order</th>
                <th className={cn(TH, "text-right")}>Rewards</th><th className={TH}>Joined</th><th className={TH}><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={7} loading={list.isLoading && !data} failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)} onRetry={() => void list.reload()}
                title="No referrals here" hint="When a customer signs up with someone's code, it appears here." />
              {data?.items.map((row) => (
                <tr key={row.id} className="align-top hover:bg-admin-raised">
                  <td className={TD}>
                    {row.referrer ? <Link href={`/admin/customers/detail?id=${encodeURIComponent(row.referrer.id)}`} className="font-medium text-admin-ink hover:text-copper-700">{row.referrer.name}</Link> : "—"}
                    <span className="block text-admin-muted">Code {row.code}</span>
                  </td>
                  <td className={TD}>
                    {row.referee ? <Link href={`/admin/customers/detail?id=${encodeURIComponent(row.referee.id)}`} className="font-medium text-admin-ink hover:text-copper-700">{row.referee.name}</Link> : "—"}
                    <span className="block text-admin-muted">{row.referee?.email}</span>
                  </td>
                  <td className={TD}>
                    <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                    {row.flagLabels.length ? <span className="mt-1 block text-[#8a5a12]">{row.flagLabels.join("; ")}</span> : null}
                    {row.note ? <span className="mt-1 block text-admin-muted">{row.note}</span> : null}
                  </td>
                  <td className={TD}>{row.order ? <Link href={`/admin/orders/detail?id=${row.order.id}`} className="text-admin-ink hover:text-copper-700">{row.order.orderNumber} · {rupees(row.order.total)}</Link> : <span className="text-admin-muted">—</span>}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>
                    {row.status === "rewarded" || row.status === "reversed" ? (
                      <>{reward(row, row.referrerReward)} + {reward(row, row.refereeReward)}{row.reversalShortfall ? <span className="block text-[#a32424]">{reward(row, row.reversalShortfall)} already spent</span> : null}</>
                    ) : "—"}
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.createdAt)}</td>
                  <td className={cn(TD, "text-right whitespace-nowrap")}>
                    {row.status === "review" ? <AdminButton size="sm" variant="primary" onClick={() => setDeciding({ row, action: "approve" })}>Approve</AdminButton> : null}
                    {row.status === "review" || row.status === "pending" ? <AdminButton size="sm" variant="ghost" onClick={() => setDeciding({ row, action: "reject" })}>Reject</AdminButton> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
      {data ? <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
        totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} /> : null}

      <DecisionDialog value={deciding} onClose={() => setDeciding(null)} onDone={() => { void list.reload(); void metrics.reload(); }} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function DecisionDialog({ value, onClose, onDone }: { value: { row: AdminReferral; action: "approve" | "reject" } | null; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const approve = value?.action === "approve";
  const submit = async () => {
    if (!value) return;
    setBusy(true);
    try {
      await decideReferral(value.row.id, value.action, note);
      toast.success(approve ? "Approved — rewards paid." : "Referral rejected.");
      setNote("");
      onClose();
      onDone();
    } catch (error) {
      toast.error(problem(error, "That didn't work."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={value !== null} onOpenChange={(open) => !open && onClose()} title={approve ? "Approve and pay the rewards?" : "Reject this referral?"} className="max-w-md">
      <p className="text-sm text-admin-muted">
        {approve
          ? "Both customers get the reward set in the programme settings. It's paid once, and taken back if the order is cancelled, returned or refunded."
          : "Neither customer is rewarded for this referral. Say why — it's kept with the referral."}
      </p>
      {value?.row.flagLabels.length ? <p className="mt-2 text-xs text-[#8a5a12]">Held because: {value.row.flagLabels.join("; ")}</p> : null}
      <div className="mt-3"><AdminInput label={approve ? "Note (optional)" : "Reason"} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} required={!approve} /></div>
      <div className="mt-5 flex justify-end gap-2">
        <AdminButton onClick={onClose} disabled={busy}>Cancel</AdminButton>
        <AdminButton variant={approve ? "primary" : "danger"} loading={busy} disabled={!approve && note.trim().length < 5} onClick={() => void submit()}>
          {approve ? "Approve" : "Reject"}
        </AdminButton>
      </div>
    </Modal>
  );
}

function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useAdminResource(() => getReferralSettings(), [open], { enabled: open });
  const [form, setForm] = useState<ReferralSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);
  const points = form?.rewardType === "points";
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      setForm(await saveReferralSettings(form));
      toast.success("Referral settings saved.");
      onClose();
    } catch (error) {
      toast.error(problem(error, "The settings weren't saved."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="Referral programme" className="max-w-2xl">
      {!form ? <p className="text-sm text-admin-muted">{settings.error ? problem(settings.error, "This didn't load.") : "Loading…"}</p> : (
        <div className="flex flex-col gap-3">
          <AdminToggle label="Programme is running" description="Off: codes can't be used to sign up and no new rewards are paid." checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
          <FormGrid>
            <AdminSelect label="Reward" value={form.rewardType} onChange={(e) => setForm({ ...form, rewardType: e.target.value as ReferralSettings["rewardType"] })}
              options={[{ value: "store_credit", label: "Store credit" }, { value: "points", label: "Reward points" }]} />
            <AdminSelect label="Paid when the first order is" value={form.rewardOn} onChange={(e) => setForm({ ...form, rewardOn: e.target.value as ReferralSettings["rewardOn"] })}
              options={[{ value: "delivered", label: "Delivered (safer: can't be cancelled)" }, { value: "paid", label: "Paid" }]} />
            <AdminInput label={`Referrer gets (${points ? "points" : "₹"})`} type="number" min={0} value={form.referrerReward} onChange={(e) => setForm({ ...form, referrerReward: Number(e.target.value) })} />
            <AdminInput label={`New customer gets (${points ? "points" : "₹"})`} type="number" min={0} value={form.refereeReward} onChange={(e) => setForm({ ...form, refereeReward: Number(e.target.value) })} />
            <AdminInput label="First order at least" type="number" min={0} prefix="₹" value={form.minOrderAmount} onChange={(e) => setForm({ ...form, minOrderAmount: Number(e.target.value) })} />
            <AdminInput label="Days to place it" type="number" min={1} max={365} value={form.windowDays} onChange={(e) => setForm({ ...form, windowDays: Number(e.target.value) })} />
            <AdminInput label="Rewards per referrer per month" type="number" min={1} max={1000} value={form.maxRewardsPerMonth} onChange={(e) => setForm({ ...form, maxRewardsPerMonth: Number(e.target.value) })} />
          </FormGrid>
          <AdminToggle label="Hold suspicious referrals for review" description="The same phone number, delivery to the referrer's address, or several sign-ups from one network wait for a person instead of paying automatically."
            checked={form.holdSuspicious} onChange={(holdSuspicious) => setForm({ ...form, holdSuspicious })} />
          <div className="flex justify-end gap-2">
            <AdminButton onClick={onClose}>Cancel</AdminButton>
            <AdminButton variant="primary" loading={busy} onClick={() => void save()}>Save settings</AdminButton>
          </div>
        </div>
      )}
    </Modal>
  );
}
