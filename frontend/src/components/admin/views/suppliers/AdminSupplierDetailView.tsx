"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Pencil, Plus, Star, Trash2 } from "lucide-react";

import type { SupplierAddress, SupplierDetail, SupplierProduct, SupplierStatus } from "@/types/suppliers";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { Detail, TD, TH, TableState, Tile } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { listPurchaseOrders } from "@/services/purchaseOrdersService";
import { getSupplier, listSupplierProducts, removeSupplierProduct, setSupplierStatus } from "@/services/suppliersService";
import { toast } from "@/store/toastStore";

import {
  ADMIN_CRUMB,
  LoadFailed,
  NoAccess,
  PageSkeleton,
  PoStatusBadge,
  SUPPLIERS_CRUMB,
  SupplierStatusBadge,
  isForbidden,
  isNotFound,
  problem,
  rupees,
} from "./shared";
import { SupplierProductDialog } from "./SupplierProductDialog";

type Tab = "products" | "purchase-orders" | "deliveries" | "history";

const TABS: { value: Tab; label: string }[] = [
  { value: "products", label: "Products" },
  { value: "purchase-orders", label: "Purchase orders" },
  { value: "deliveries", label: "Recent deliveries" },
  { value: "history", label: "History" },
];

const NOT_ENOUGH = "Not enough history yet";

const TAX_LABELS: Record<string, string> = {
  registered: "Registered",
  unregistered: "Unregistered",
  composition: "Composition scheme",
  overseas: "Overseas",
};

function addressText(address: SupplierAddress | null | undefined): string {
  if (!address) return "";
  return [address.line1, address.line2, address.city, address.state, address.pincode, address.country].filter(Boolean).join(", ");
}

const humanize = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ") : "");

/** `/admin/suppliers/detail?id=SUP001`: stats, products, purchase orders, deliveries and history. */
export function AdminSupplierDetailView() {
  const params = useSearchParams();
  const supplierId = params?.get("id") ?? "";
  const supplier = useAdminResource(() => getSupplier(supplierId), [supplierId], { enabled: Boolean(supplierId) });
  const crumbs = [ADMIN_CRUMB, SUPPLIERS_CRUMB, { label: supplier.data?.name ?? supplierId ?? "Supplier" }];

  if (!supplierId || isNotFound(supplier.error)) {
    return (
      <div>
        <AdminPageHeader title="Supplier not found" breadcrumbs={[ADMIN_CRUMB, SUPPLIERS_CRUMB, { label: "Not found" }]} />
        <p className="text-sm text-admin-muted">We couldn&rsquo;t find this supplier. The link may be out of date.</p>
        <AdminButtonLink href="/admin/suppliers" size="sm" className="mt-4">
          Back to suppliers
        </AdminButtonLink>
      </div>
    );
  }
  if (isForbidden(supplier.error)) {
    return (
      <div>
        <AdminPageHeader title="Supplier" breadcrumbs={crumbs} />
        <NoAccess area="suppliers" />
      </div>
    );
  }
  if (supplier.error && !supplier.data) {
    return (
      <div>
        <AdminPageHeader title="Supplier" breadcrumbs={crumbs} />
        <LoadFailed message={problem(supplier.error, "The supplier didn't load.")} onRetry={() => void supplier.reload()} />
      </div>
    );
  }
  if (!supplier.data) return <PageSkeleton label="Loading supplier" />;

  return <SupplierDetailBody supplier={supplier.data} reload={supplier.reload} />;
}

function SupplierDetailBody({ supplier, reload }: { supplier: SupplierDetail; reload: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("products");
  const [statusChange, setStatusChange] = useState<SupplierStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const stats = supplier.stats;

  const changeStatus = async (status: SupplierStatus) => {
    setBusy(true);
    try {
      await setSupplierStatus(supplier.id, status);
      toast.success(status === "archived" ? "Supplier archived" : status === "active" ? "Supplier activated" : "Supplier marked inactive");
      setStatusChange(null);
      await reload();
    } catch (error) {
      toast.error(problem(error, "The status wasn't changed. Please try again."));
      setStatusChange(null);
    } finally {
      setBusy(false);
    }
  };

  const statusCopy: Record<SupplierStatus, { label: string; message: string; destructive: boolean }> = {
    archived: {
      label: "Archive",
      message: "Archive this supplier? It disappears from the supplier list and can't be used on new purchase orders. Past orders keep it.",
      destructive: true,
    },
    inactive: {
      label: "Mark inactive",
      message: "Mark this supplier inactive? No new purchase orders can be raised until it's active again.",
      destructive: true,
    },
    active: { label: "Activate", message: "Activate this supplier so purchase orders can be raised again?", destructive: false },
  };

  return (
    <div>
      <AdminPageHeader
        title={supplier.name}
        description={[supplier.code, supplier.legalName && supplier.legalName !== supplier.name ? supplier.legalName : ""].filter(Boolean).join(" · ")}
        breadcrumbs={[ADMIN_CRUMB, SUPPLIERS_CRUMB, { label: supplier.name }]}
        actions={
          <>
            <SupplierStatusBadge status={supplier.status} />
            <AdminButtonLink href={`/admin/suppliers/edit?id=${encodeURIComponent(supplier.id)}`} size="sm">
              <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Edit
            </AdminButtonLink>
            {supplier.status === "active" ? (
              <AdminButtonLink href={`/admin/purchase-orders/new?supplier=${encodeURIComponent(supplier.id)}`} size="sm" variant="primary">
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                New purchase order
              </AdminButtonLink>
            ) : null}
            {supplier.status !== "active" ? (
              <AdminButton size="sm" onClick={() => setStatusChange("active")} disabled={busy}>
                Activate
              </AdminButton>
            ) : (
              <AdminButton size="sm" variant="ghost" onClick={() => setStatusChange("inactive")} disabled={busy}>
                Mark inactive
              </AdminButton>
            )}
            {supplier.status !== "archived" ? (
              <AdminButton size="sm" variant="ghost" onClick={() => setStatusChange("archived")} disabled={busy}>
                Archive
              </AdminButton>
            ) : null}
          </>
        }
      />

      <section aria-label="Supplier statistics" className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Tile label="Products" value={String(stats.productCount)} hint={`${stats.activeProductCount} active`} />
        <Tile label="Purchase orders" value={String(stats.poCount)} hint={`${stats.openPoCount} open`} />
        <Tile label="Received orders" value={String(stats.receivedPoCount)} />
        <Tile label="Total purchased" value={rupees(stats.totalPurchaseValue)} />
        <Tile label="Outstanding units" value={stats.outstandingQuantity.toLocaleString("en-IN")} tone={stats.outstandingQuantity ? "warn" : undefined} />
        <Tile
          label="Average lead time"
          value={stats.averageLeadTimeDays === null ? "—" : `${stats.averageLeadTimeDays} ${stats.averageLeadTimeDays === 1 ? "day" : "days"}`}
          hint={stats.averageLeadTimeDays === null ? NOT_ENOUGH : undefined}
        />
        <Tile
          label="On time"
          value={stats.onTimeRate === null ? "—" : `${stats.onTimeRate}%`}
          hint={stats.onTimeRate === null ? NOT_ENOUGH : undefined}
        />
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <div role="tablist" aria-label="Supplier sections" className="mb-3 flex flex-wrap gap-1.5">
            {TABS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                role="tab"
                id={`supplier-tab-${entry.value}`}
                aria-selected={tab === entry.value}
                aria-controls={`supplier-panel-${entry.value}`}
                onClick={() => setTab(entry.value)}
                className={cn(
                  "rounded-[3px] px-2.5 py-1.5 text-xs transition-colors",
                  tab === entry.value
                    ? "bg-admin-ink text-white"
                    : "bg-admin-surface text-admin-muted ring-1 ring-inset ring-admin-border hover:text-admin-ink",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`supplier-panel-${tab}`} aria-labelledby={`supplier-tab-${tab}`}>
            {tab === "products" ? <ProductsTab supplier={supplier} onChanged={reload} /> : null}
            {tab === "purchase-orders" ? <PurchaseOrdersTab supplier={supplier} /> : null}
            {tab === "deliveries" ? <DeliveriesTab supplier={supplier} /> : null}
            {tab === "history" ? <HistoryTab supplier={supplier} /> : null}
          </div>
        </div>

        <AdminCard title="Details">
          <dl className="grid gap-3 text-xs">
            <Detail label="Contact">{supplier.contactPerson || "—"}</Detail>
            <Detail label="Phone">{supplier.phone || "—"}</Detail>
            <Detail label="Email">{supplier.email ? <a className="hover:text-copper-700" href={`mailto:${supplier.email}`}>{supplier.email}</a> : "—"}</Detail>
            <Detail label="Website">{supplier.website || "—"}</Detail>
            <Detail label="Business type">{humanize(supplier.businessType) || "—"}</Detail>
            <Detail label="Tax treatment">{TAX_LABELS[supplier.taxTreatment] ?? supplier.taxTreatment}</Detail>
            <Detail label="GSTIN">{supplier.gstin || "—"}</Detail>
            <Detail label="PAN">{supplier.pan || "—"}</Detail>
            <Detail label="Billing address">{addressText(supplier.billingAddress) || "—"}</Detail>
            <Detail label="Warehouse">{addressText(supplier.warehouseAddress) || "Same as billing"}</Detail>
            <Detail label="Payment terms">
              {[supplier.paymentTerms, `${supplier.creditDays} credit days`].filter(Boolean).join(" · ")}
            </Detail>
            <Detail label="Currency">{supplier.currency}</Detail>
            {supplier.notes ? <Detail label="Notes"><span className="whitespace-pre-line">{supplier.notes}</span></Detail> : null}
          </dl>
        </AdminCard>
      </div>

      {statusChange ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && !busy && setStatusChange(null)}
          title={`${statusCopy[statusChange].label} ${supplier.name}?`}
          message={statusCopy[statusChange].message}
          confirmLabel={statusCopy[statusChange].label}
          destructive={statusCopy[statusChange].destructive}
          loading={busy}
          onConfirm={() => void changeStatus(statusChange)}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- products */

function ProductsTab({ supplier, onChanged }: { supplier: SupplierDetail; onChanged: () => Promise<void> }) {
  const links = useAdminResource(() => listSupplierProducts(supplier.id), [supplier.id]);
  const [editing, setEditing] = useState<SupplierProduct | "new" | null>(null);
  const [removing, setRemoving] = useState<SupplierProduct | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = links.data ?? [];
  const canAdd = supplier.status !== "archived";

  const remove = async (link: SupplierProduct) => {
    setBusy(true);
    try {
      await removeSupplierProduct(link.id);
      toast.success(`${link.productName} removed from ${supplier.name}`);
      setRemoving(null);
      await Promise.all([links.reload(), onChanged()]);
    } catch (error) {
      toast.error(problem(error, "The product wasn't removed. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminCard
      title="Products supplied"
      description="What this supplier sells you, at what cost. The cost is prefilled on purchase orders."
      padded={false}
      action={
        canAdd ? (
          <AdminButton size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Link a product
          </AdminButton>
        ) : undefined
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-xs">
          <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
            <tr>
              <th className={TH}>Product</th>
              <th className={TH}>Supplier SKU</th>
              <th className={cn(TH, "text-right")}>Cost</th>
              <th className={cn(TH, "text-right")}>MOQ</th>
              <th className={cn(TH, "text-right")}>Lead time</th>
              <th className={TH}>Status</th>
              <th className={cn(TH, "text-right")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-admin-border">
            <TableState
              columns={7}
              loading={links.isLoading && !links.data}
              failed={Boolean(links.error && !links.data)}
              empty={Boolean(links.data && rows.length === 0)}
              onRetry={() => void links.reload()}
              title="No products linked yet"
              hint={canAdd ? "Link the products you buy from this supplier to prefill purchase orders." : "This supplier is archived."}
            />
            {rows.map((row) => (
              <tr key={row.id} className="align-top hover:bg-admin-raised">
                <td className={TD}>
                  <Link href={`/admin/products/edit?id=${encodeURIComponent(row.productId)}`} className="block font-medium text-admin-ink hover:text-copper-700">
                    {row.productName}
                  </Link>
                  <span className="block text-admin-muted">
                    {row.productSku}
                    {row.productStatus && row.productStatus !== "active" ? ` · ${humanize(row.productStatus)}` : ""}
                  </span>
                </td>
                <td className={cn(TD, "font-mono text-admin-muted")}>{row.supplierSku || "—"}</td>
                <td className={cn(TD, "text-right tabular-nums text-admin-ink")}>{rupees(row.purchaseCost)}</td>
                <td className={cn(TD, "text-right tabular-nums")}>{row.moq}</td>
                <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>
                  {row.leadTimeDays === null ? "—" : `${row.leadTimeDays} d`}
                </td>
                <td className={TD}>
                  <span className="flex flex-wrap items-center gap-1">
                    <StatusBadge tone={row.status === "active" ? "good" : "neutral"}>{humanize(row.status)}</StatusBadge>
                    {row.preferred ? (
                      <StatusBadge tone="info">
                        <Star className="mr-1 h-3 w-3" strokeWidth={2} aria-hidden="true" />
                        Preferred
                      </StatusBadge>
                    ) : null}
                  </span>
                </td>
                <td className={cn(TD, "whitespace-nowrap text-right")}>
                  <AdminButton size="sm" variant="ghost" onClick={() => setEditing(row)} aria-label={`Edit ${row.productName}`}>
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </AdminButton>
                  <AdminButton size="sm" variant="ghost" onClick={() => setRemoving(row)} aria-label={`Remove ${row.productName}`}>
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </AdminButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing ? (
        <SupplierProductDialog
          supplierId={supplier.id}
          supplierName={supplier.name}
          link={editing === "new" ? undefined : editing}
          linkedProductIds={rows.map((row) => row.productId)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void Promise.all([links.reload(), onChanged()]);
          }}
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && !busy && setRemoving(null)}
          title={`Remove ${removing.productName}?`}
          message={`${supplier.name} will no longer be listed as a supplier of this product. Existing purchase orders are not changed.`}
          confirmLabel="Remove"
          loading={busy}
          onConfirm={() => void remove(removing)}
        />
      ) : null}
    </AdminCard>
  );
}

/* --------------------------------------------------------- purchase orders */

function PurchaseOrdersTab({ supplier }: { supplier: SupplierDetail }) {
  const orders = useAdminResource(() => listPurchaseOrders({ supplier: supplier.id, pageSize: 25 }), [supplier.id]);
  if (isForbidden(orders.error)) return <NoAccess area="purchasing" />;
  const rows = orders.data?.items ?? [];
  const total = orders.data?.pagination.total ?? 0;

  return (
    <AdminCard
      title="Purchase orders"
      description={total > rows.length ? `The latest ${rows.length} of ${total}.` : undefined}
      padded={false}
      action={
        <AdminButtonLink href={`/admin/purchase-orders?supplier=${encodeURIComponent(supplier.id)}`} size="sm" variant="ghost">
          View all
        </AdminButtonLink>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-left text-xs">
          <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
            <tr>
              <th className={TH}>PO</th>
              <th className={TH}>Status</th>
              <th className={cn(TH, "text-right")}>Items</th>
              <th className={cn(TH, "text-right")}>Total</th>
              <th className={TH}>Expected</th>
              <th className={cn(TH, "text-right")}>Raised</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-admin-border">
            <TableState
              columns={6}
              loading={orders.isLoading && !orders.data}
              failed={Boolean(orders.error && !orders.data)}
              empty={Boolean(orders.data && rows.length === 0)}
              onRetry={() => void orders.reload()}
              title="No purchase orders yet"
              hint={supplier.status === "active" ? "Raise one with “New purchase order” above." : "Activate the supplier to raise one."}
            />
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-admin-raised">
                <td className={TD}>
                  <Link href={`/admin/purchase-orders/detail?id=${encodeURIComponent(row.id)}`} className="font-medium text-admin-ink hover:text-copper-700">
                    {row.poNumber}
                  </Link>
                </td>
                <td className={TD}>
                  <PoStatusBadge status={row.status} label={row.statusLabel} />
                </td>
                <td className={cn(TD, "text-right tabular-nums")}>{row.itemCount}</td>
                <td className={cn(TD, "text-right tabular-nums text-admin-ink")}>{rupees(row.total)}</td>
                <td className={cn(TD, "text-admin-muted")}>{row.expectedAt ? formatDate(row.expectedAt) : "—"}</td>
                <td className={cn(TD, "text-right text-admin-muted")}>{formatDate(row.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminCard>
  );
}

/* --------------------------------------------------------------- deliveries */

function DeliveriesTab({ supplier }: { supplier: SupplierDetail }) {
  const deliveries = supplier.recentDeliveries ?? [];
  return (
    <AdminCard title="Recent deliveries" description="The last five goods receipts.">
      {deliveries.length === 0 ? (
        <p className="py-6 text-center text-sm text-admin-muted">Nothing received from this supplier yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-admin-border">
          {deliveries.map((receipt) => {
            const accepted = receipt.items.reduce((sum, item) => sum + item.acceptedQty, 0);
            const received = receipt.items.reduce((sum, item) => sum + item.receivedQty, 0);
            return (
              <li key={receipt.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2.5 text-xs first:pt-0 last:pb-0">
                <span>
                  <span className="block font-medium text-admin-ink">{receipt.receiptNumber}</span>
                  <span className="text-admin-muted">
                    {receipt.items.length} {receipt.items.length === 1 ? "line" : "lines"} · {received} received · {accepted} accepted
                  </span>
                </span>
                <span className="text-admin-muted">{formatDate(receipt.receivedAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </AdminCard>
  );
}

/* ------------------------------------------------------------------ history */

function HistoryTab({ supplier }: { supplier: SupplierDetail }) {
  const history = supplier.history ?? [];
  return (
    <AdminCard title="History" description="Changes to this supplier and its purchase orders, newest first.">
      {history.length === 0 ? (
        <p className="py-6 text-center text-sm text-admin-muted">No history yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {history.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="flex gap-2.5">
              <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill bg-copper-500" />
              <span className="text-xs">
                <span className="block text-admin-ink">{entry.summary || humanize(entry.action)}</span>
                <span className="block text-[0.625rem] text-admin-muted">
                  {formatDateTime(entry.at)}
                  {entry.actor ? ` · ${entry.actor}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </AdminCard>
  );
}
