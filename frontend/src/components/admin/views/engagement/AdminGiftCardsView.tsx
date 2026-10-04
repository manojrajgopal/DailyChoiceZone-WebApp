"use client";

import { useState } from "react";
import { Download, Gift, RefreshCw, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminTextarea, AdminToggle } from "@/components/admin/ui/AdminForm";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { LogFooter, StatusTabs, collectPages, downloadCsv, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Badge, Detail, TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import {
  getGiftCard,
  getGiftCardSettings,
  giftCardAction,
  issueGiftCard,
  listGiftCards,
  saveGiftCardSettings,
  type GiftCardSettings,
} from "@/services/admin/engagementAdminService";
import { toast } from "@/store/toastStore";

const KEYS = ["status", "q", "customer"] as const;

const rupees = (value: number) =>
  `₹${value.toLocaleString("en-IN", { minimumFractionDigits: value % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  active: { label: "Active", tone: "green" },
  "partially-used": { label: "Partly used", tone: "green" },
  used: { label: "Used up", tone: "grey" },
  expired: { label: "Expired", tone: "grey" },
  disabled: { label: "Disabled", tone: "red" },
  refunded: { label: "Refunded", tone: "grey" },
  pending: { label: "Awaiting payment", tone: "amber" },
  cancelled: { label: "Abandoned", tone: "grey" },
};

/**
 * Gift cards: who bought or was sent them, what's left on each, and their
 * history. Codes are never shown here — only the last four characters; a
 * card whose email went astray gets a new code instead.
 *
 * A card is found by ID (docs/id-lookup.md): its Gift card ID, its
 * purchaser's Customer ID, or a whole code someone reads out. The code is kept
 * out of the address bar — it is what spends the card.
 */
export function AdminGiftCardsView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const [openId, setOpenId] = useState<number | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [codeText, setCodeText] = useState("");
  const [code, setCode] = useState("");
  const search = { status: filters.status, q: filters.q, customer: filters.customer, code };

  const list = useAdminResource(() => listGiftCards({ ...search, page, pageSize }), [filters, code, page, pageSize]);
  const data = list.data;
  const counts = data?.counts ?? {};
  const filtered = Boolean(filters.status || filters.q || filters.customer || code);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { rows, truncated } = await collectPages((p) => listGiftCards({ ...search, page: p, pageSize: 100 }));
      downloadCsv(
        `gift-cards-${new Date().toISOString().slice(0, 10)}.csv`,
        ["Reference", "Ends in", "Status", "Value (INR)", "Balance (INR)", "Source", "Purchaser", "Recipient", "Recipient email", "Created", "Expires"],
        rows.map((row) => [
          row.reference, row.last4, STATUS[row.status]?.label ?? row.status, row.initialAmount, row.balance, row.source,
          row.purchaser?.email ?? "", row.recipientName, row.recipientEmail, formatDateTime(row.createdAt),
          row.expiresAt ? formatDateTime(row.expiresAt) : "",
        ]),
      );
      toast.success(truncated ? `Exported the newest ${rows.length} cards.` : `Exported ${rows.length} cards.`);
    } catch (error) {
      toast.error(problem(error, "The export didn't work."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <AdminPageHeader
        title="Gift cards"
        description="Cards customers bought and cards issued by the store, their balances and every movement."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Gift cards" }]}
        actions={
          <>
            <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
              {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Refresh
            </AdminButton>
            <AdminButton size="sm" onClick={() => void exportCsv()} loading={exporting} disabled={!data || data.pagination.total === 0}>
              {exporting ? null : <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Export CSV
            </AdminButton>
            <AdminButton size="sm" variant="primary" onClick={() => setIssuing(true)}>
              <Gift className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Issue a gift card
            </AdminButton>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Unspent balance" value={data ? rupees(data.outstanding) : null} hint="On active cards" />
        <Tile label="Active" value={data ? String(counts.active ?? 0) : null} tone="good" />
        <Tile label="Used up" value={data ? String(counts.used ?? 0) : null} />
        <Tile label="Disabled or expired" value={data ? String((counts.disabled ?? 0) + (counts.expired ?? 0)) : null} />
      </div>

      <StatusTabs
        label="Filter cards"
        value={filters.status}
        onChange={(status) => setFilters({ status })}
        tabs={[
          { value: "", label: "All" },
          { value: "active", label: "Active", count: counts.active },
          { value: "partially-used", label: "Partly used" },
          { value: "used", label: "Used up", count: counts.used },
          { value: "expired", label: "Expired" },
          { value: "disabled", label: "Disabled", count: counts.disabled },
          { value: "pending", label: "Awaiting payment", count: counts.pending },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <IdFilter entity="gift_card" value={filters.q} onChange={(q) => setFilters({ q })} className="min-w-[13rem]" />
        <IdFilter entity="customer" value={filters.customer} onChange={(customer) => setFilters({ customer })}
          label="Purchaser Customer ID" className="min-w-[13rem]" />
        <form
          className="flex min-w-[13rem] flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            setCode(codeText.trim());
          }}
        >
          <label htmlFor="gift-card-code" className="text-xs font-medium text-admin-ink">Full gift card code</label>
          <input
            id="gift-card-code"
            value={codeText}
            onChange={(event) => {
              setCodeText(event.target.value);
              if (!event.target.value.trim()) setCode("");
            }}
            autoComplete="off"
            spellCheck={false}
            placeholder="DCZG-XXXX-XXXX-XXXX-XXXX, then Enter"
            className="h-9 w-full rounded-[3px] border border-admin-border bg-admin-surface px-2.5 font-mono text-[0.8125rem] text-admin-ink placeholder:text-admin-faint hover:border-admin-border-strong focus:border-copper-500"
          />
        </form>
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={() => {
            setCodeText("");
            setCode("");
            clear();
          }}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="relative overflow-x-auto">
          <table className={cn("w-full min-w-[60rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Card</th>
                <th className={TH}>Status</th>
                <th className={cn(TH, "text-right")}>Balance</th>
                <th className={TH}>Purchaser</th>
                <th className={TH}>Recipient</th>
                <th className={TH}>Created</th>
                <th className={TH}>Expires</th>
                <th className={cn(TH, "text-right")}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={8} loading={list.isLoading && !data} failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)} onRetry={() => void list.reload()}
                title={filtered ? "No gift cards match" : "No gift cards yet"}
                hint={filtered ? "Check the ID or code, or try a different filter." : "Cards appear when customers buy them or you issue one."} />
              {data?.items.map((row) => {
                const status = STATUS[row.status] ?? STATUS.active!;
                return (
                  <tr key={row.id} className="align-top hover:bg-admin-raised">
                    <td className={TD}>
                      <span className="block font-medium text-admin-ink">{row.reference}</span>
                      <span className="block font-mono text-admin-muted">•••• {row.last4}</span>
                    </td>
                    <td className={TD}><Badge tone={status.tone}>{status.label}</Badge></td>
                    <td className={cn(TD, "text-right tabular-nums")}>
                      <span className="block text-admin-ink">{rupees(row.balance)}</span>
                      <span className="block text-admin-muted">of {rupees(row.initialAmount)}</span>
                    </td>
                    <td className={cn(TD, "text-admin-muted")}>{row.purchaser?.email ?? (row.source === "admin" ? "Issued by the store" : "—")}</td>
                    <td className={TD}>
                      <span className="block text-admin-ink">{row.recipientName}</span>
                      <span className="block text-admin-muted">{row.recipientEmail}</span>
                    </td>
                    <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(row.createdAt)}</td>
                    <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{row.expiresAt ? formatDateTime(row.expiresAt) : "Never"}</td>
                    <td className={cn(TD, "text-right")}>
                      <AdminButton size="sm" variant="ghost" onClick={() => setOpenId(row.id)} aria-label={`Open ${row.reference}`}>Open</AdminButton>
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

      <CardDialog id={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />
      <IssueDialog open={issuing} onOpenChange={setIssuing} onIssued={() => void list.reload()} />
      <GiftCardSettingsCard />
    </div>
  );
}

function CardDialog({ id, onClose, onChanged }: { id: number | null; onClose: () => void; onChanged: () => void }) {
  const detail = useAdminResource(() => getGiftCard(id ?? 0), [id], { enabled: id !== null });
  const card = detail.data;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");

  const act = async (action: "disable" | "enable" | "reissue" | "refund", done: string) => {
    setBusy(action);
    try {
      await giftCardAction(card!.id, action, reason);
      toast.success(done);
      setReason("");
      await detail.reload();
      onChanged();
    } catch (error) {
      toast.error(problem(error, "That didn't work."));
    } finally {
      setBusy("");
    }
  };

  return (
    <Modal open={id !== null} onOpenChange={(open) => !open && onClose()} title={card ? `Gift card ${card.reference}` : "Gift card"} className="max-w-2xl">
      {!card ? (
        <p className="text-sm text-ink-500">{detail.error ? problem(detail.error, "This card didn't load.") : "Loading…"}</p>
      ) : (
        <div className="flex flex-col gap-5 text-xs">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label="Ends in"><span className="font-mono">•••• {card.last4}</span></Detail>
            <Detail label="Status">{(STATUS[card.status] ?? STATUS.active!).label}{card.statusReason ? ` — ${card.statusReason}` : ""}</Detail>
            <Detail label="Balance">{rupees(card.balance)} of {rupees(card.initialAmount)}</Detail>
            <Detail label="Expires">{card.expiresAt ? formatDateTime(card.expiresAt) : "Never"}</Detail>
            <Detail label="From">{card.source === "admin" ? "Issued by the store" : `${card.senderName} (${card.purchaser?.email ?? "—"})`}</Detail>
            <Detail label="To">{card.recipientName} · {card.recipientEmail}</Detail>
            <Detail label="Delivered">{card.deliveredAt ? formatDateTime(card.deliveredAt) : "Not yet"}</Detail>
            <Detail label="Payment">{card.gatewayPaymentId ?? (card.source === "admin" ? "—" : "Not paid")}</Detail>
            {card.message ? <Detail label="Message" wide>{card.message}</Detail> : null}
          </dl>

          <section>
            <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">Emails</h3>
            {card.emails && card.emails.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {card.emails.map((mail, index) => (
                  <li key={index} className="flex flex-wrap items-baseline justify-between gap-2 border-l-2 border-admin-border pl-2.5">
                    <span className="text-admin-ink">{mail.subject} <span className="text-admin-muted">→ {mail.to}</span></span>
                    <span className={mail.status === "failed" ? "text-[#a12b2b]" : "text-[#0a6b0a]"}>
                      {mail.status === "failed" ? `Failed: ${mail.error}` : `Sent ${formatDateTime(mail.at)}`}
                    </span>
                  </li>
                ))}
                <li className="text-admin-faint">“Sent” means the mail server accepted it. If the recipient can&rsquo;t find it, ask them to check Spam or Promotions.</li>
              </ul>
            ) : (
              <p className="text-[#a12b2b]">No email has been sent for this card yet — check that an email account is connected, then use “Email a new code”.</p>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">History</h3>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-left">
                <thead className="text-admin-muted"><tr><th className="py-1.5 pr-3 font-medium">When</th><th className="py-1.5 pr-3 font-medium">What</th><th className="py-1.5 pr-3 text-right font-medium">Amount</th><th className="py-1.5 text-right font-medium">Balance</th></tr></thead>
                <tbody className="divide-y divide-admin-border">
                  {card.transactions?.map((t, index) => (
                    <tr key={index}>
                      <td className="py-1.5 pr-3 whitespace-nowrap text-admin-muted">{formatDateTime(t.at)}</td>
                      <td className="py-1.5 pr-3 text-admin-ink">{t.label}{t.orderId ? ` · ${t.orderId}` : ""}{t.note ? <span className="block text-admin-muted">{t.note}</span> : null}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{t.amount ? `${t.amount > 0 ? "+" : "−"}${rupees(Math.abs(t.amount))}` : "—"}</td>
                      <td className="py-1.5 text-right tabular-nums">{rupees(t.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {card.status !== "pending" && card.status !== "cancelled" ? (
            <section className="flex flex-col gap-2 border-t border-admin-border pt-4">
              <AdminInput label="Reason (required, kept in the history)" value={reason} maxLength={300}
                onChange={(event) => setReason(event.target.value)} placeholder="e.g. Customer reported the email was lost" />
              <div className="flex flex-wrap gap-2">
                {["active", "partially-used", "used"].includes(card.status) ? (
                  <AdminButton loading={busy === "disable"} disabled={busy !== "" || reason.trim().length < 5}
                    onClick={() => void act("disable", "Card disabled.")}>Disable</AdminButton>
                ) : null}
                {card.status === "disabled" ? (
                  <AdminButton loading={busy === "enable"} disabled={busy !== "" || reason.trim().length < 5}
                    onClick={() => void act("enable", "Card re-enabled.")}>Re-enable</AdminButton>
                ) : null}
                {card.usable ? (
                  <AdminButton loading={busy === "reissue"} disabled={busy !== "" || reason.trim().length < 5}
                    onClick={() => void act("reissue", "New code emailed to the recipient.")}>New code</AdminButton>
                ) : null}
                {card.source === "purchase" && card.gatewayPaymentId && card.balance === card.initialAmount &&
                ["active", "disabled"].includes(card.rawStatus) ? (
                  <AdminButton loading={busy === "refund"} disabled={busy !== "" || reason.trim().length < 5}
                    onClick={() => void act("refund", "Refunded to the purchaser.")}>Refund unused card</AdminButton>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function IssueDialog({ open, onOpenChange, onIssued }: { open: boolean; onOpenChange: (open: boolean) => void; onIssued: () => void }) {
  const [form, setForm] = useState({ amount: "", recipientName: "", recipientEmail: "", message: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const card = await issueGiftCard({ ...form, amount: Number(form.amount) });
      if (card.deliveredAt) toast.success(`Gift card issued and emailed to ${card.recipientEmail}.`);
      else toast.error("Gift card issued, but it couldn't be emailed — check that an email account is connected, then use “Email a new code”.");
      setForm({ amount: "", recipientName: "", recipientEmail: "", message: "", reason: "" });
      onOpenChange(false);
      onIssued();
    } catch (error) {
      toast.error(problem(error, "The card wasn't issued."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Issue a gift card" className="max-w-lg"
      description="The card is emailed to the recipient with its code straight away. Use it for prizes and goodwill.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <AdminInput label="Amount" type="number" min={1} step="0.01" prefix="₹" value={form.amount} onChange={set("amount")} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <AdminInput label="Recipient's name" value={form.recipientName} onChange={set("recipientName")} required maxLength={120} />
          <AdminInput label="Recipient's email" type="email" value={form.recipientEmail} onChange={set("recipientEmail")} required maxLength={255} />
        </div>
        <AdminTextarea label="Message (optional)" value={form.message} onChange={set("message")} rows={2} maxLength={300} />
        <AdminInput label="Reason (internal)" value={form.reason} onChange={set("reason")} required maxLength={300}
          hint="Why the store is issuing this card — kept on the card." />
        <div>
          <AdminButton type="submit" variant="primary" loading={busy}
            disabled={!form.amount || !form.recipientName || !form.recipientEmail || form.reason.trim().length < 5}>
            Issue
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}

function GiftCardSettingsCard() {
  const loaded = useAdminResource(getGiftCardSettings, []);
  const [draft, setDraft] = useState<GiftCardSettings | null>(null);
  // Typed text while editing; the saved list otherwise.
  const [typed, setTyped] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? loaded.data;
  const denominations = typed ?? loaded.data?.denominations.join(", ") ?? "";
  const setDenominations = setTyped;

  const patch = (next: Partial<GiftCardSettings>) => value && setDraft({ ...value, ...next });

  const save = async () => {
    if (!value) return;
    setSaving(true);
    try {
      const amounts = denominations.split(/[,\s]+/).filter(Boolean).map(Number);
      await saveGiftCardSettings({ ...value, denominations: amounts });
      toast.success("Gift card settings saved.");
      setDraft(null);
      setTyped(null);
      await loaded.reload();
    } catch (error) {
      toast.error(problem(error, "The settings weren't saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminCard title="Settings" description="What customers can buy, how long cards last, and how cards and store credit combine." className="mt-8">
      {!value ? (
        <p className="text-sm text-admin-muted">{loaded.error ? "The settings didn't load." : "Loading…"}</p>
      ) : (
        <div className="flex max-w-3xl flex-col gap-5">
          <AdminToggle label="Sell gift cards" checked={value.enabled} onChange={(enabled) => patch({ enabled })}
            description="Customers can buy cards on the Gift cards page. Cards already issued keep working either way." />
          <div className="grid gap-4 sm:grid-cols-3">
            <AdminInput label="Smallest card (₹)" type="number" min={1} value={value.minAmount} onChange={(e) => patch({ minAmount: Number(e.target.value) })} />
            <AdminInput label="Largest card (₹)" type="number" min={1} value={value.maxAmount} onChange={(e) => patch({ maxAmount: Number(e.target.value) })} />
            <AdminInput label="Valid for (months)" type="number" min={0} max={120} value={value.validityMonths}
              onChange={(e) => patch({ validityMonths: Number(e.target.value) })} hint="0: cards don't expire" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <AdminInput label="Amounts offered (₹, comma-separated)" value={denominations}
              onChange={(e) => { setDenominations(e.target.value); patch({}); }} />
            <AdminInput label="Cards per order" type="number" min={1} max={5} value={value.maxCardsPerOrder}
              onChange={(e) => patch({ maxCardsPerOrder: Number(e.target.value) })} />
          </div>
          <AdminToggle label="Let customers choose their own amount" checked={value.allowCustomAmount} onChange={(allowCustomAmount) => patch({ allowCustomAmount })} />
          <AdminToggle label="Gift cards can be used with a coupon" checked={value.allowWithCoupons} onChange={(allowWithCoupons) => patch({ allowWithCoupons })} />
          <div className="border-t border-admin-border pt-4">
            <p className="mb-3 text-xs font-medium text-admin-ink">Store credit</p>
            <div className="flex flex-col gap-3">
              <AdminToggle label="Customers can spend store credit at checkout" checked={value.storeCreditEnabled} onChange={(storeCreditEnabled) => patch({ storeCreditEnabled })} />
              <AdminToggle label="Store credit can be combined with gift cards" checked={value.storeCreditWithGiftCards} onChange={(storeCreditWithGiftCards) => patch({ storeCreditWithGiftCards })} />
              <AdminToggle label="Store credit can be combined with a coupon" checked={value.storeCreditWithCoupons} onChange={(storeCreditWithCoupons) => patch({ storeCreditWithCoupons })} />
            </div>
          </div>
          <div className="flex gap-2">
            <AdminButton variant="primary" onClick={() => void save()} loading={saving} disabled={!draft}>Save settings</AdminButton>
            {draft ? <AdminButton variant="ghost" onClick={() => { setDraft(null); setTyped(null); }}>Discard changes</AdminButton> : null}
          </div>
        </div>
      )}
    </AdminCard>
  );
}
