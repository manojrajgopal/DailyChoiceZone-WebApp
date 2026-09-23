"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { PackageCheck, Search, X } from "lucide-react";

import type { InventoryItem, StockAdjustment, StockStatus } from "@/types/admin";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea } from "@/components/admin/ui/AdminForm";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate, humanize } from "@/lib/utils/format";
import { currentActorId } from "@/services/admin/adminAuthService";
import {
  ADJUSTMENT_REASONS,
  adjustStock,
  listInventory,
  listStockLog,
} from "@/services/admin/inventoryAdminService";
import { toast } from "@/store/toastStore";

/**
 * Inventory.
 *
 * Rows are derived from products, so stock has exactly one home. The available
 * figure — stock minus what is reserved for unfulfilled orders — is the one
 * that decides whether something is low, because reserved units cannot be sold
 * again.
 */
export function AdminInventoryView() {
  const inventory = useAdminResource(() => listInventory(), []);
  const log = useAdminResource(() => listStockLog(), []);

  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<StockStatus | "all">("all");
  const [category, setCategory] = useState("all");

  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [newStock, setNewStock] = useState("");
  const [reason, setReason] = useState<StockAdjustment["reason"]>("restock");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const items = inventory.data ?? [];

  const categories = useMemo(
    () => [...new Set(items.map((item) => item.category))].sort(),
    [items],
  );

  const filtered = useMemo(() => {
    const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      if (status !== "all" && item.status !== status) return false;
      if (category !== "all" && item.category !== category) return false;
      if (terms.length > 0) {
        const haystack = `${item.name} ${item.sku}`.toLowerCase();
        if (!terms.every((token) => haystack.includes(token))) return false;
      }
      return true;
    });
  }, [items, term, status, category]);

  const counts = useMemo(
    () => ({
      total: items.length,
      low: items.filter((item) => item.status === "low-stock").length,
      out: items.filter((item) => item.status === "out-of-stock").length,
      units: items.reduce((sum, item) => sum + item.stock, 0),
    }),
    [items],
  );

  const openAdjust = (item: InventoryItem) => {
    setEditing(item);
    setNewStock(String(item.stock));
    setReason("restock");
    setNote("");
  };

  const onSave = async () => {
    if (!editing) return;
    setSaving(true);
    const result = await adjustStock({
      productId: editing.productId,
      newStock: Number(newStock),
      reason,
      note: note.trim(),
      by: currentActorId(),
    });
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${editing.name} stock set to ${result.data.stock}`);
    setEditing(null);
    await Promise.all([inventory.reload(), log.reload()]);
  };

  const columns: Column<InventoryItem>[] = [
    {
      id: "product",
      header: "Product",
      sortValue: (item) => item.name,
      cell: (item) => (
        <span className="flex items-center gap-2.5">
          <span className="h-9 w-7 shrink-0 overflow-hidden rounded-[2px] bg-admin-raised">
            {item.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.image} alt="" className="h-full w-full object-cover" />
            ) : null}
          </span>
          <span className="min-w-0">
            <Link
              href={`/admin/products/edit?id=${item.productId}`}
              className="block max-w-[13rem] truncate text-admin-ink hover:text-copper-700"
            >
              {item.name}
            </Link>
            <span className="block text-[0.625rem] text-admin-faint">{item.sku}</span>
          </span>
        </span>
      ),
    },
    {
      id: "category",
      header: "Category",
      hideBelow: "md",
      sortValue: (item) => item.category,
      cell: (item) => <span className="text-xs text-admin-muted">{humanize(item.category)}</span>,
    },
    {
      id: "stock",
      header: "Stock",
      align: "right",
      sortValue: (item) => item.stock,
      cell: (item) => <span className="tabular-nums">{item.stock}</span>,
    },
    {
      id: "reserved",
      header: "Reserved",
      align: "right",
      hideBelow: "sm",
      sortValue: (item) => item.reserved,
      cell: (item) => (
        <span className={cn("tabular-nums", item.reserved > 0 ? "text-admin-ink" : "text-admin-faint")}>
          {item.reserved}
        </span>
      ),
    },
    {
      id: "available",
      header: "Available",
      align: "right",
      sortValue: (item) => item.available,
      cell: (item) => (
        <span
          className={cn(
            "font-medium tabular-nums",
            item.available === 0
              ? "text-[#a32424]"
              : item.status === "low-stock"
                ? "text-[#8a5d00]"
                : "text-admin-ink",
          )}
        >
          {item.available}
        </span>
      ),
    },
    {
      id: "threshold",
      header: "Threshold",
      align: "right",
      hideBelow: "lg",
      sortValue: (item) => item.lowStockThreshold,
      cell: (item) => (
        <span className="tabular-nums text-admin-muted">{item.lowStockThreshold}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (item) => item.status,
      cell: (item) => <DomainStatus domain="stock" status={item.status} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (item) => (
        <AdminButton size="sm" variant="secondary" onClick={() => openAdjust(item)}>
          Update stock
        </AdminButton>
      ),
    },
  ];

  const selectClass =
    "h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink hover:border-admin-border-strong focus:border-copper-500";

  const delta = editing ? Number(newStock) - editing.stock : 0;

  return (
    <div>
      <AdminPageHeader
        title="Inventory"
        description="Stock levels across the catalogue. Available is stock minus units reserved for unfulfilled orders."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Inventory" }]}
      />

      {/* ------------------------------------------------------ quick counts */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Tracked products", value: counts.total, tone: "" },
          { label: "Low stock", value: counts.low, tone: "text-[#8a5d00]" },
          { label: "Out of stock", value: counts.out, tone: "text-[#a32424]" },
          { label: "Units on hand", value: counts.units, tone: "" },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-[3px] border border-admin-border bg-admin-surface p-3"
          >
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
              {stat.label}
            </p>
            <p className={cn("mt-1.5 text-lg font-semibold tabular-nums", stat.tone || "text-admin-ink")}>
              {stat.value.toLocaleString("en-IN")}
            </p>
          </div>
        ))}
      </div>

      {/* ---------------------------------------------------------- filters */}
      <div className="mb-4 rounded-[3px] border border-admin-border bg-admin-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="inventory-search" className="sr-only">
              Search inventory by product name or SKU
            </label>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              id="inventory-search"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Product or SKU…"
              className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-raised pl-8 pr-2 text-xs text-admin-ink placeholder:text-admin-faint focus:border-copper-500 focus:bg-admin-surface"
            />
          </div>

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as StockStatus | "all")}
            aria-label="Filter by stock status"
            className={selectClass}
          >
            <option value="all">All levels</option>
            <option value="in-stock">In stock</option>
            <option value="low-stock">Low stock</option>
            <option value="out-of-stock">Out of stock</option>
          </select>

          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="Filter by category"
            className={selectClass}
          >
            <option value="all">All categories</option>
            {categories.map((option) => (
              <option key={option} value={option}>
                {humanize(option)}
              </option>
            ))}
          </select>

          {status !== "all" || category !== "all" || term ? (
            <AdminButton
              size="sm"
              variant="ghost"
              onClick={() => {
                setStatus("all");
                setCategory("all");
                setTerm("");
              }}
            >
              <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              Clear
            </AdminButton>
          ) : null}
        </div>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(item) => item.productId}
        isLoading={inventory.isLoading}
        pageSize={15}
        initialSort={{ columnId: "available", direction: "asc" }}
        emptyTitle="Nothing matches"
        emptyDescription="Adjust the search or filters above."
      />

      {/* -------------------------------------------------------- stock log */}
      {(log.data ?? []).length > 0 ? (
        <AdminCard
          title="Recent stock changes"
          description="Every adjustment made in this browser session."
          className="mt-4"
        >
          <ul className="flex flex-col divide-y divide-admin-border">
            {(log.data ?? []).slice(0, 8).map((entry, index) => {
              const item = items.find((row) => row.productId === entry.productId);
              return (
                <li
                  key={`${entry.productId}-${entry.at}-${index}`}
                  className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0"
                >
                  <PackageCheck
                    className="h-3.5 w-3.5 shrink-0 text-admin-faint"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-admin-ink">
                      {item?.name ?? entry.productId}
                    </span>
                    <span className="block text-[0.625rem] text-admin-muted">
                      Set to {entry.newStock} · {humanize(entry.reason)}
                      {entry.note ? ` · ${entry.note}` : ""} · {formatDate(entry.at)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </AdminCard>
      ) : null}

      {/* ----------------------------------------------- adjustment modal */}
      <Modal
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title="Update stock"
        description={editing?.name}
        className="max-w-md"
      >
        {editing ? (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-3 gap-2 rounded-[3px] bg-admin-raised p-3 text-center">
              {[
                ["Current", editing.stock],
                ["Reserved", editing.reserved],
                ["Available", editing.available],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <dt className="text-[0.5625rem] uppercase tracking-[0.1em] text-admin-muted">
                    {label}
                  </dt>
                  <dd className="mt-0.5 text-sm font-semibold text-admin-ink tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>

            <AdminInput
              label="New stock quantity"
              type="number"
              min={0}
              value={newStock}
              onChange={(event) => setNewStock(event.target.value)}
              autoFocus
              hint={
                delta === 0
                  ? "No change."
                  : delta > 0
                    ? `Adding ${delta} unit${delta === 1 ? "" : "s"}.`
                    : `Removing ${Math.abs(delta)} unit${Math.abs(delta) === 1 ? "" : "s"}.`
              }
            />

            <AdminSelect
              label="Reason"
              value={reason}
              onChange={(event) => setReason(event.target.value as StockAdjustment["reason"])}
              options={ADJUSTMENT_REASONS.map((entry) => ({
                value: entry.value,
                label: entry.label,
              }))}
            />

            <AdminTextarea
              label="Note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              hint="Optional. Recorded against the change."
            />

            {Number(newStock) === 0 ? (
              <p className="rounded-[3px] bg-[#fdf3dd] px-3 py-2 text-[0.6875rem] text-[#8a5d00]">
                Setting stock to zero will mark this product out of stock on the storefront.
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <AdminButton variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </AdminButton>
              <AdminButton variant="primary" loading={saving} onClick={() => void onSave()}>
                Save stock
              </AdminButton>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
