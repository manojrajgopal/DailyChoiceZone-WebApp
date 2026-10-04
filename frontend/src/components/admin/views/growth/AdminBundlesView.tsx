"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea, FormGrid } from "@/components/admin/ui/AdminForm";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { LogFooter, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { ProductPicker, fromLocalInput, rupees, toLocalInput } from "@/components/admin/views/growth/shared";
import { Badge, TD, TH, TableState, Tile, problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import {
  type AdminBundle,
  type BundleInput,
  createBundle,
  deleteBundle,
  getBundle,
  listBundles,
  updateBundle,
} from "@/services/admin/growthAdminService";
import { toast } from "@/store/toastStore";

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "grey" }> = {
  active: { label: "Active", tone: "green" },
  draft: { label: "Draft", tone: "amber" },
  archived: { label: "Archived", tone: "grey" },
};

const KEYS = ["status", "q"] as const;

/** Bundles: products sold together for one price, with stock from their components. */
export function AdminBundlesView() {
  const { filters, page, pageSize, setFilters, setPage, setPageSize } = useUrlFilters(KEYS);
  const list = useAdminResource(() => listBundles({ status: filters.status, q: filters.q, page, pageSize }), [filters, page, pageSize]);
  const data = list.data;

  return (
    <div>
      <AdminPageHeader
        title="Bundles"
        description="Existing products sold together for one price. A bundle has no stock of its own: what can be sold comes from its products."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Bundles" }]}
        actions={
          <div className="flex gap-2">
            <AdminButton size="sm" onClick={() => void list.reload()} loading={list.isRefreshing}>
              {list.isRefreshing ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} Refresh
            </AdminButton>
            <AdminButtonLink size="sm" variant="primary" href="/admin/bundles/detail">
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> New bundle
            </AdminButtonLink>
          </div>
        }
      />
      <StatusTabs label="Which bundles" value={filters.status} onChange={(status) => setFilters({ status })}
        tabs={[{ value: "", label: "All" }, ...Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label, count: data?.counts[value] }))]} />
      <div className="mb-3 max-w-sm"><IdFilter entity="bundle" value={filters.q} onChange={(q) => setFilters({ q })} /></div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[52rem] text-left text-xs", list.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Bundle</th><th className={TH}>Status</th><th className={cn(TH, "text-right")}>Price</th>
                <th className={cn(TH, "text-right")}>Saving</th><th className={cn(TH, "text-right")}>Can sell</th>
                <th className={cn(TH, "text-right")}>Sold</th><th className={cn(TH, "text-right")}>Revenue</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState columns={7} loading={list.isLoading && !data} failed={Boolean(list.error && !data)}
                empty={Boolean(data && data.items.length === 0)} onRetry={() => void list.reload()}
                title="No bundles here" hint="Create one from two or more products." />
              {data?.items.map((bundle) => (
                <tr key={bundle.id} className="hover:bg-admin-raised">
                  <td className={TD}>
                    <Link href={`/admin/bundles/detail?id=${bundle.id}`} className="font-medium text-admin-ink hover:text-copper-700">{bundle.name}</Link>
                    <span className="block text-admin-muted">{bundle.components.map((c) => `${c.quantity} × ${c.product.name}`).join(", ")}</span>
                  </td>
                  <td className={TD}><Badge tone={STATUS[bundle.status]?.tone ?? "grey"}>{STATUS[bundle.status]?.label ?? bundle.status}</Badge></td>
                  <td className={cn(TD, "text-right tabular-nums")}>{rupees(bundle.price)}<span className="block text-admin-muted line-through">{rupees(bundle.regularPrice)}</span></td>
                  <td className={cn(TD, "text-right tabular-nums")}>{rupees(bundle.saving)} ({bundle.savingPercent}%)</td>
                  <td className={cn(TD, "text-right tabular-nums", bundle.available === 0 && "text-[#a32424]")}>{bundle.available}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{bundle.sales.units}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{rupees(bundle.sales.revenue)}</td>
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

interface Component {
  productId: string;
  name: string;
  price: number;
  available: number;
  quantity: number;
}

interface Form {
  name: string;
  description: string;
  image: string;
  status: BundleInput["status"];
  pricing: BundleInput["pricing"];
  fixedPrice: string;
  discountPercent: string;
  maxPerOrder: string;
  startsAt: string;
  endsAt: string;
  components: Component[];
}

const EMPTY: Form = { name: "", description: "", image: "", status: "draft", pricing: "fixed", fixedPrice: "", discountPercent: "10",
  maxPerOrder: "5", startsAt: "", endsAt: "", components: [] };

function fromBundle(b: AdminBundle): Form {
  return {
    name: b.name, description: b.description, image: b.ownImage, status: b.status, pricing: b.pricing,
    fixedPrice: b.fixedPrice === null ? "" : String(b.fixedPrice), discountPercent: b.discountPercent === null ? "10" : String(b.discountPercent),
    maxPerOrder: String(b.maxPerOrder), startsAt: toLocalInput(b.startsAt), endsAt: toLocalInput(b.endsAt),
    components: b.components.map((c) => ({ productId: c.productId, name: c.product.name, price: c.regularPrice, available: c.available, quantity: c.quantity })),
  };
}

/** Create or edit a bundle. The price and what can be sold are worked out by the server; shown here as a preview. */
export function AdminBundleDetailView() {
  const params = useSearchParams();
  const router = useRouter();
  const id = Number(params.get("id")) || null;
  const bundle = useAdminResource(() => getBundle(id ?? 0), [id], { enabled: id !== null });
  const [form, setForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (bundle.data) setForm(fromBundle(bundle.data));
  }, [bundle.data]);

  const preview = useMemo(() => {
    const regular = form.components.reduce((sum, c) => sum + c.price * c.quantity, 0);
    const price = form.pricing === "fixed" ? Number(form.fixedPrice) || 0 : regular * (1 - (Number(form.discountPercent) || 0) / 100);
    const available = form.components.length ? Math.min(...form.components.map((c) => Math.floor(c.available / Math.max(1, c.quantity)))) : 0;
    return { regular, price, available };
  }, [form]);

  const save = async () => {
    setBusy(true);
    const payload: BundleInput = {
      name: form.name, description: form.description, image: form.image, status: form.status, pricing: form.pricing,
      fixedPrice: form.pricing === "fixed" ? Number(form.fixedPrice) : null,
      discountPercent: form.pricing === "percent" ? Number(form.discountPercent) : null,
      maxPerOrder: Number(form.maxPerOrder), startsAt: form.startsAt ? fromLocalInput(form.startsAt) : null,
      endsAt: form.endsAt ? fromLocalInput(form.endsAt) : null,
      items: form.components.map((c) => ({ productId: c.productId, quantity: c.quantity })),
    };
    try {
      if (id) {
        await updateBundle(id, payload);
        await bundle.reload();
      } else {
        const created = await createBundle(payload);
        router.replace(`/admin/bundles/detail?id=${created.id}`);
      }
      toast.success("Bundle saved.");
    } catch (error) {
      toast.error(problem(error, "The bundle wasn't saved."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await deleteBundle(id);
      toast.success("Bundle deleted.");
      router.replace("/admin/bundles");
    } catch (error) {
      toast.error(problem(error, "It wasn't deleted."));
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  if (id && bundle.isLoading && !bundle.data) return <p className="text-sm text-admin-muted">Loading…</p>;
  if (id && bundle.error && !bundle.data) return <p className="text-sm text-admin-ink">{problem(bundle.error, "This bundle didn't load.")}</p>;
  const current = bundle.data;
  const setComponent = (index: number, quantity: number) =>
    setForm((f) => ({ ...f, components: f.components.map((c, i) => (i === index ? { ...c, quantity } : c)) }));

  return (
    <div>
      <AdminPageHeader title={current ? current.name : "New bundle"}
        description="Choose at least two products, how many of each, and the price for the set."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Bundles", href: "/admin/bundles" }, { label: current?.name ?? "New" }]}
        actions={current ? <Badge tone={STATUS[current.status]?.tone ?? "grey"}>{STATUS[current.status]?.label}</Badge> : null} />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Products bought separately" value={rupees(preview.regular)} />
        <Tile label="Bundle price" value={rupees(Math.round(preview.price * 100) / 100)} tone={preview.price && preview.price < preview.regular ? "good" : "warn"} />
        <Tile label="Can be sold now" value={String(preview.available)} hint="The scarcest product decides" />
        {current ? <Tile label="Sold" value={`${current.sales.units} · ${rupees(current.sales.revenue)}`} hint={`${current.sales.orders} orders`} /> : null}
      </div>

      <AdminCard>
        <FormGrid>
          <AdminInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={200} required />
          <AdminSelect label="Status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Form["status"] })}
            options={[{ value: "draft", label: "Draft — not in the shop" }, { value: "active", label: "Active — on sale" }, { value: "archived", label: "Archived" }]} />
          <AdminSelect label="Pricing" value={form.pricing} onChange={(e) => setForm({ ...form, pricing: e.target.value as Form["pricing"] })}
            options={[{ value: "fixed", label: "A fixed price" }, { value: "percent", label: "A percentage off" }]} />
          {form.pricing === "fixed" ? (
            <AdminInput label="Bundle price" type="number" min={1} step="0.01" prefix="₹" value={form.fixedPrice} onChange={(e) => setForm({ ...form, fixedPrice: e.target.value })} required />
          ) : (
            <AdminInput label="Percentage off" type="number" min={1} max={90} step="0.5" value={form.discountPercent} onChange={(e) => setForm({ ...form, discountPercent: e.target.value })} required />
          )}
          <AdminInput label="Most per order" type="number" min={1} max={20} value={form.maxPerOrder} onChange={(e) => setForm({ ...form, maxPerOrder: e.target.value })} />
          <AdminInput label="Image address (optional)" value={form.image} onChange={(e) => setForm({ ...form, image: e.target.value })} hint="Empty: the first product's photo." />
          <AdminInput label="Available from (optional)" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          <AdminInput label="Available until (optional)" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
        </FormGrid>
        <div className="mt-3"><AdminTextarea label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} /></div>
      </AdminCard>

      <AdminCard className="mt-4" padded={false}>
        <table className="w-full text-left text-xs">
          <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
            <tr><th className={TH}>Product</th><th className={cn(TH, "text-right")}>Price</th><th className={TH}>Quantity</th><th className={cn(TH, "text-right")}>Available</th><th className={TH}><span className="sr-only">Remove</span></th></tr>
          </thead>
          <tbody className="divide-y divide-admin-border">
            {form.components.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-admin-muted">Add at least two products below.</td></tr>
            ) : form.components.map((c, index) => (
              <tr key={c.productId}>
                <td className={TD}><span className="font-medium text-admin-ink">{c.name}</span><span className="block text-admin-muted">{c.productId}</span></td>
                <td className={cn(TD, "text-right tabular-nums")}>{rupees(c.price)}</td>
                <td className={TD}><input aria-label={`Quantity of ${c.name}`} type="number" min={1} max={10} value={c.quantity}
                  onChange={(e) => setComponent(index, Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className="h-8 w-20 rounded-[3px] border border-admin-border px-2" /></td>
                <td className={cn(TD, "text-right tabular-nums")}>{c.available}</td>
                <td className={cn(TD, "text-right")}>
                  <AdminButton size="sm" variant="ghost" aria-label={`Remove ${c.name}`} onClick={() => setForm((f) => ({ ...f, components: f.components.filter((_, i) => i !== index) }))}>
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </AdminButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-3">
          <ProductPicker chosen={form.components.map((c) => c.productId)} onPick={(p) => setForm((f) => ({
            ...f, components: [...f.components, { productId: p.id, name: p.name, price: p.price, available: Math.max(0, p.stock - p.reservedStock), quantity: 1 }],
          }))} />
        </div>
      </AdminCard>

      <div className="mt-4 flex gap-2">
        <AdminButton variant="primary" loading={busy} onClick={() => void save()}>Save bundle</AdminButton>
        {current ? <AdminButton variant="ghost" onClick={() => setConfirm(true)}>Delete</AdminButton> : null}
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this bundle?" loading={busy} onConfirm={() => void remove()}
        message="It's removed from the shop and from bags. A bundle that has been ordered is kept for the record — archive it instead." />
    </div>
  );
}
