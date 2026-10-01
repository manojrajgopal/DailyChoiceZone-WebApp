"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminTextarea, AdminToggle, FormGrid } from "@/components/admin/ui/AdminForm";
import { LogFooter, LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { ProductPicker, fromLocalInput, rupees, toLocalInput } from "@/components/admin/views/growth/shared";
import { Badge, TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import {
  type AdminFlashSale,
  type FlashPhase,
  type FlashSaleInput,
  createFlashSale,
  deleteFlashSale,
  flashSaleAction,
  getFlashSale,
  listFlashSales,
  updateFlashSale,
} from "@/services/admin/growthAdminService";
import { toast } from "@/store/toastStore";

const PHASE: Record<FlashPhase, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  live: { label: "Live", tone: "green" },
  scheduled: { label: "Scheduled", tone: "amber" },
  draft: { label: "Draft", tone: "grey" },
  ended: { label: "Ended", tone: "grey" },
  cancelled: { label: "Cancelled", tone: "red" },
};

const KEYS = ["phase", "q"] as const;

/** Flash sales: every sale, what it's selling, and how it's doing. */
export function AdminFlashSalesView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize } = useUrlFilters(KEYS);
  const list = useAdminResource(() => listFlashSales({ phase: filters.phase, q: filters.q, page, pageSize }),
    [filters, page, pageSize]);
  const data = list.data;
  const counts = data?.counts;

  return (
    <div>
      <AdminPageHeader
        title="Flash sales"
        description="Timed sale prices on chosen products, with limited units and a limit per customer. Prices are applied by the server at checkout."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Flash sales" }]}
        actions={
          <div className="flex gap-2">
            <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
              {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
            </AdminButton>
            <AdminButtonLink size="sm" variant="primary" href="/admin/flash-sales/detail">
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> New flash sale
            </AdminButtonLink>
          </div>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Live now" value={counts ? String(counts.live) : null} tone={counts?.live ? "good" : undefined} />
        <Tile label="Scheduled" value={counts ? String(counts.scheduled) : null} />
        <Tile label="Drafts" value={counts ? String(counts.draft) : null} />
        <Tile label="Ended" value={counts ? String(counts.ended) : null} />
      </div>

      <StatusTabs label="Which sales" value={filters.phase} onChange={(phase) => setFilters({ phase })}
        tabs={[{ value: "", label: "All" }, ...(["live", "scheduled", "draft", "ended", "cancelled"] as FlashPhase[]).map((p) => ({
          value: p, label: PHASE[p].label, count: counts?.[p],
        }))]} />
      <div className="mb-3"><LogSearch label="Find a sale" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Sale name" /></div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[52rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Sale</th><th className={TH}>Status</th><th className={TH}>Runs</th>
                <th className={cn(TH, "text-right")}>Products</th><th className={cn(TH, "text-right")}>Sold</th>
                <th className={cn(TH, "text-right")}>Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={6} loading={list.isLoading && !data} failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)} onRetry={() => void list.reload()}
                title="No flash sales here" hint="Create one to put chosen products on sale for a set time." />
              {data?.items.map((sale) => (
                <tr key={sale.id} className="hover:bg-admin-raised">
                  <td className={TD}>
                    <Link href={`/admin/flash-sales/detail?id=${sale.id}`} className="font-medium text-admin-ink hover:text-copper-700">{sale.name}</Link>
                    {sale.description ? <span className="block text-admin-muted">{sale.description}</span> : null}
                  </td>
                  <td className={TD}><Badge tone={PHASE[sale.phase].tone}>{PHASE[sale.phase].label}</Badge></td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>{formatDateTime(sale.startsAt)} – {formatDateTime(sale.endsAt)}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{sale.itemCount ?? sale.items.length}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{sale.totals.sold}{sale.totals.reserved ? <span className="text-admin-muted"> (+{sale.totals.reserved} held)</span> : null}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{rupees(sale.totals.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
      {data ? <LogFooter page={data.pagination.page} pageSize={pageSize} total={data.pagination.total}
        totalPages={data.pagination.total_pages} onPage={setPage} onPageSize={setPageSize} /> : null}
    </div>
  );
}

interface Row {
  productId: string;
  name: string;
  regularPrice: number;
  available: number;
  salePrice: string;
  stockLimit: string;
  perCustomerLimit: string;
}

function blank(): { name: string; description: string; startsAt: string; endsAt: string; allowCoupons: boolean; rows: Row[] } {
  const start = new Date(Date.now() + 60 * 60_000);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60_000);
  return { name: "", description: "", startsAt: toLocalInput(start.toISOString()), endsAt: toLocalInput(end.toISOString()),
    allowCoupons: false, rows: [] };
}

function fromSale(sale: AdminFlashSale) {
  return {
    name: sale.name, description: sale.description, startsAt: toLocalInput(sale.startsAt), endsAt: toLocalInput(sale.endsAt),
    allowCoupons: sale.allowCoupons,
    rows: sale.items.map((item) => ({
      productId: item.productId, name: item.product.name, regularPrice: item.product.price, available: item.product.available,
      salePrice: String(item.salePrice), stockLimit: item.stockLimit === null ? "" : String(item.stockLimit),
      perCustomerLimit: item.perCustomerLimit === null ? "" : String(item.perCustomerLimit),
    })),
  };
}

/** Create or edit one sale, and see how each of its products is selling. */
export function AdminFlashSaleDetailView() {
  const params = useSearchParams();
  const router = useRouter();
  const id = Number(params.get("id")) || null;
  const sale = useAdminResource(() => getFlashSale(id ?? 0), [id], { enabled: id !== null });
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState<"" | "cancel" | "delete" | "end">("");

  useEffect(() => {
    if (sale.data) setForm(fromSale(sale.data));
  }, [sale.data]);

  const current = sale.data;
  const locked = current ? current.phase === "ended" || current.phase === "cancelled" : false;
  const live = current?.phase === "live";

  const input = (publish?: boolean): FlashSaleInput => ({
    name: form.name, description: form.description, startsAt: fromLocalInput(form.startsAt), endsAt: fromLocalInput(form.endsAt),
    allowCoupons: form.allowCoupons, publish,
    items: form.rows.map((row) => ({
      productId: row.productId, salePrice: Number(row.salePrice),
      stockLimit: row.stockLimit === "" ? null : Number(row.stockLimit),
      perCustomerLimit: row.perCustomerLimit === "" ? null : Number(row.perCustomerLimit),
    })),
  });

  const save = async (publish?: boolean) => {
    setBusy(publish ? "publish" : "save");
    try {
      if (id) {
        await updateFlashSale(id, input());
        if (publish && current?.status === "draft") await flashSaleAction(id, "publish");
        toast.success(publish ? "Saved and published." : "Saved.");
        await sale.reload();
      } else {
        const created = await createFlashSale(input(publish));
        toast.success(publish ? "Flash sale published." : "Saved as a draft.");
        router.replace(`/admin/flash-sales/detail?id=${created.id}`);
      }
    } catch (error) {
      toast.error(problem(error, "The sale wasn't saved."));
    } finally {
      setBusy("");
    }
  };

  const act = async (action: "publish" | "unpublish" | "cancel" | "end") => {
    if (!id) return;
    setBusy(action);
    try {
      await flashSaleAction(id, action);
      toast.success({ publish: "Published.", unpublish: "Back to draft.", cancel: "Sale cancelled.", end: "Sale ended." }[action]);
      setConfirm("");
      await sale.reload();
    } catch (error) {
      toast.error(problem(error, "That didn't work."));
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    if (!id) return;
    setBusy("delete");
    try {
      await deleteFlashSale(id);
      toast.success("Flash sale deleted.");
      router.replace("/admin/flash-sales");
    } catch (error) {
      toast.error(problem(error, "It wasn't deleted."));
      setConfirm("");
    } finally {
      setBusy("");
    }
  };

  const setRow = (index: number, patch: Partial<Row>) =>
    setForm((f) => ({ ...f, rows: f.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) }));

  if (id && sale.isLoading && !current) return <p className="text-sm text-admin-muted">Loading…</p>;
  if (id && sale.error && !current) return <p className="text-sm text-admin-ink">{problem(sale.error, "This sale didn't load.")}</p>;

  const stats = new Map(current?.items.map((item) => [item.productId, item]) ?? []);

  return (
    <div>
      <AdminPageHeader
        title={current ? current.name : "New flash sale"}
        description={current ? `${formatDateTime(current.startsAt)} – ${formatDateTime(current.endsAt)}` : "Choose the products, the sale prices and when it runs."}
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Flash sales", href: "/admin/flash-sales" }, { label: current?.name ?? "New" }]}
        actions={current ? <Badge tone={PHASE[current.phase].tone}>{PHASE[current.phase].label}</Badge> : null}
      />

      {current ? (
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Units sold" value={String(current.totals.sold)} />
          <Tile label="Held for unpaid orders" value={String(current.totals.reserved)} />
          <Tile label="Revenue at sale price" value={rupees(current.totals.revenue)} />
          <Tile label="Customers saved" value={rupees(current.totals.savings)} />
        </div>
      ) : null}

      <AdminCard>
        <FormGrid>
          <AdminInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} required disabled={locked} />
          <AdminInput label="Starts" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required disabled={locked || live} hint={live ? "It has started; the start can't change." : "Your local time."} />
          <AdminInput label="Ends" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} required disabled={locked} />
        </FormGrid>
        <div className="mt-3"><AdminTextarea label="Description (shown on the sale page)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} rows={2} disabled={locked} /></div>
        <div className="mt-2"><AdminToggle label="Coupons can be used with this sale" description="Off: an order with this sale's products can't use a coupon." checked={form.allowCoupons} onChange={(allowCoupons) => setForm({ ...form, allowCoupons })} disabled={locked} /></div>
      </AdminCard>

      <AdminCard className="mt-4" padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-left text-xs">
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Product</th><th className={cn(TH, "text-right")}>Regular</th><th className={TH}>Sale price (₹)</th>
                <th className={TH}>Units at sale price</th><th className={TH}>Per customer</th>
                {current ? <th className={cn(TH, "text-right")}>Sold / held / left</th> : null}<th className={TH}><span className="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              {form.rows.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-admin-muted">Add products below.</td></tr>
              ) : form.rows.map((row, index) => {
                const stat = stats.get(row.productId);
                const price = Number(row.salePrice);
                const off = row.salePrice && price < row.regularPrice ? Math.round((1 - price / row.regularPrice) * 100) : null;
                return (
                  <tr key={row.productId}>
                    <td className={TD}><span className="font-medium text-admin-ink">{row.name}</span><span className="block text-admin-muted">{row.productId} · {row.available} available</span></td>
                    <td className={cn(TD, "text-right tabular-nums")}>{rupees(row.regularPrice)}</td>
                    <td className={TD}>
                      <input aria-label={`Sale price for ${row.name}`} type="number" min={1} step="0.01" value={row.salePrice} disabled={locked}
                        onChange={(e) => setRow(index, { salePrice: e.target.value })} className="h-8 w-28 rounded-[3px] border border-admin-border px-2 tabular-nums" />
                      {off !== null ? <span className="ml-2 text-admin-muted">{off}% off</span> : row.salePrice ? <span className="ml-2 text-[#a32424]">Must be lower</span> : null}
                    </td>
                    <td className={TD}><input aria-label={`Units for ${row.name}`} type="number" min={1} placeholder="As stock allows" value={row.stockLimit} disabled={locked}
                      onChange={(e) => setRow(index, { stockLimit: e.target.value })} className="h-8 w-32 rounded-[3px] border border-admin-border px-2" /></td>
                    <td className={TD}><input aria-label={`Limit per customer for ${row.name}`} type="number" min={1} max={100} placeholder="No limit" value={row.perCustomerLimit} disabled={locked}
                      onChange={(e) => setRow(index, { perCustomerLimit: e.target.value })} className="h-8 w-24 rounded-[3px] border border-admin-border px-2" /></td>
                    {current ? (
                      <td className={cn(TD, "text-right tabular-nums")}>
                        {stat ? `${stat.sold} / ${stat.reserved} / ${stat.remaining ?? "—"}` : "—"}
                        {stat?.soldOut ? <span className="block text-[#a32424]">Sold out</span> : null}
                      </td>
                    ) : null}
                    <td className={cn(TD, "text-right")}>
                      <AdminButton size="sm" variant="ghost" disabled={locked} aria-label={`Remove ${row.name}`}
                        onClick={() => setForm((f) => ({ ...f, rows: f.rows.filter((_, i) => i !== index) }))}>
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      </AdminButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!locked ? (
          <div className="p-3">
            <ProductPicker chosen={form.rows.map((r) => r.productId)} onPick={(p) => setForm((f) => ({
              ...f, rows: [...f.rows, { productId: p.id, name: p.name, regularPrice: p.price, available: Math.max(0, p.stock - p.reservedStock),
                salePrice: String(Math.floor(p.price * 0.8)), stockLimit: "", perCustomerLimit: "" }],
            }))} />
          </div>
        ) : null}
      </AdminCard>

      <div className="mt-4 flex flex-wrap gap-2">
        {!locked ? (
          <>
            <AdminButton variant={current?.status === "draft" || !current ? "secondary" : "primary"} loading={busy === "save"} onClick={() => void save()}>
              {current ? "Save changes" : "Save as draft"}
            </AdminButton>
            {!current || current.status === "draft" ? (
              <AdminButton variant="primary" loading={busy === "publish"} onClick={() => void save(true)}>Save and publish</AdminButton>
            ) : null}
          </>
        ) : null}
        {current?.phase === "scheduled" ? <AdminButton loading={busy === "unpublish"} onClick={() => void act("unpublish")}>Back to draft</AdminButton> : null}
        {live ? <AdminButton onClick={() => setConfirm("end")}>End now</AdminButton> : null}
        {current && !locked ? <AdminButton variant="danger" onClick={() => setConfirm("cancel")}>Cancel sale</AdminButton> : null}
        {current && (current.phase === "draft" || current.totals.sold + current.totals.reserved === 0) ? (
          <AdminButton variant="ghost" onClick={() => setConfirm("delete")}>Delete</AdminButton>
        ) : null}
      </div>

      <ConfirmDialog open={confirm !== ""} onOpenChange={(open) => !open && setConfirm("")}
        title={{ cancel: "Cancel this sale?", end: "End this sale now?", delete: "Delete this sale?", "": "" }[confirm]}
        message={{
          cancel: "Sale prices stop at once. Orders already placed keep the price they were placed at.",
          end: "The sale ends now. Orders already placed keep their prices.",
          delete: "The sale is removed. A sale with orders is kept for the record and can only be cancelled.",
          "": "",
        }[confirm]}
        confirmLabel={{ cancel: "Cancel sale", end: "End now", delete: "Delete", "": "" }[confirm]}
        loading={busy !== ""}
        onConfirm={() => (confirm === "delete" ? void remove() : confirm ? void act(confirm) : undefined)} />
    </div>
  );
}
