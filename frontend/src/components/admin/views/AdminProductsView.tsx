"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Copy, Eye, Pencil, Plus, Trash2, X } from "lucide-react";

import type { AdminProduct, ProductStatus } from "@/types/admin";
import type { AdminProductFlag, AdminProductSort, AdminStockFilter } from "@/types/searchAdmin";

import {
  AdminButton,
  AdminButtonLink,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column, type DataTableSort } from "@/components/admin/ui/DataTable";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { FilterSelect, PAGE_SIZES, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice, humanize } from "@/lib/utils/format";
import { currentActorId } from "@/services/admin/adminAuthService";
import {
  deleteProduct,
  duplicateProduct,
  listProductsPage,
} from "@/services/admin/productAdminService";
import { toast } from "@/store/toastStore";

const KEYS = ["q", "status", "category", "brand", "stock", "flag", "sort"] as const;

const STATUSES: (ProductStatus | "all")[] = ["all", "active", "draft", "out-of-stock", "archived"];
const STOCKS: AdminStockFilter[] = ["in-stock", "low-stock", "out-of-stock"];
const FLAGS: AdminProductFlag[] = ["isNew", "isTrending", "isBestSeller", "isFeatured"];

const SORTS: { value: AdminProductSort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "updated", label: "Recently updated" },
  { value: "name-asc", label: "Name, A–Z" },
  { value: "name-desc", label: "Name, Z–A" },
  { value: "price-asc", label: "Price, low to high" },
  { value: "price-desc", label: "Price, high to low" },
  { value: "stock-asc", label: "Stock, lowest first" },
  { value: "stock-desc", label: "Stock, highest first" },
  { value: "discount", label: "Biggest discount" },
  { value: "best-selling", label: "Best selling" },
  { value: "popular", label: "Most popular" },
  { value: "rating", label: "Highest rated" },
  { value: "category", label: "Category" },
  { value: "status", label: "Status" },
];

/** Column header clicks, as the server's sort keys — and back, for the arrows. */
const COLUMN_SORTS: Record<string, { asc: AdminProductSort; desc: AdminProductSort }> = {
  product: { asc: "name-asc", desc: "name-desc" },
  category: { asc: "category", desc: "category" },
  price: { asc: "price-asc", desc: "price-desc" },
  discount: { asc: "discount", desc: "discount" },
  stock: { asc: "stock-asc", desc: "stock-desc" },
  status: { asc: "status", desc: "status" },
  created: { asc: "oldest", desc: "newest" },
};

function tableSort(sort: string): DataTableSort | null {
  for (const [columnId, keys] of Object.entries(COLUMN_SORTS)) {
    if (keys.asc === keys.desc) {
      // One-way sorts: discount is biggest first, category and status A–Z.
      if (sort === keys.asc) return { columnId, direction: columnId === "discount" ? "desc" : "asc" };
    } else if (sort === keys.asc) return { columnId, direction: "asc" };
    else if (sort === keys.desc) return { columnId, direction: "desc" };
  }
  return null;
}

function oneOf<T extends string>(value: string, allowed: readonly T[]): T | "" {
  return (allowed as readonly string[]).includes(value) ? (value as T) : "";
}

/**
 * The product list.
 *
 * Search, filters, sort and paging are the server's (GET /admin/products), so
 * the portal never downloads the catalogue to filter it; they live in the
 * address bar, so a filtered list can be bookmarked or shared. The shared
 * `DataTable` runs in server mode: it shows the arrows and the pager and
 * reports clicks, and leaves the rows in the order the server sent.
 */
export function AdminProductsView() {
  const router = useRouter();
  const { filters, page, pageSize, setFilters, setPage, setPageSize, clear } = useUrlFilters(KEYS);
  const status = oneOf(filters.status, STATUSES) || "all";
  const stock = oneOf(filters.stock, STOCKS);
  const flag = oneOf(filters.flag, FLAGS);
  const sort = oneOf(filters.sort, SORTS.map((option) => option.value));

  const { data, isLoading, isRefreshing, reload } = useAdminResource(
    () =>
      listProductsPage({
        q: filters.q,
        status,
        category: filters.category,
        brands: filters.brand,
        stock,
        flag,
        sort,
        page,
        pageSize,
      }),
    [filters.q, status, filters.category, filters.brand, stock, flag, sort, page, pageSize],
  );

  const [pendingDelete, setPendingDelete] = useState<AdminProduct | null>(null);
  const [busy, setBusy] = useState(false);

  const products = data?.items ?? [];
  const counts = data?.counts;
  const categories = data?.filters.categories ?? [];
  const brands = data?.filters.brands ?? [];

  const filtered = Boolean(
    filters.q || status !== "all" || filters.category || filters.brand || stock || flag,
  );

  const onDuplicate = async (product: AdminProduct) => {
    setBusy(true);
    const result = await duplicateProduct(product.id, currentActorId());
    setBusy(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`Duplicated as a draft. Opening it to edit.`);
    // A duplicate is a starting point, so go straight to editing it.
    router.push(`/admin/products/edit?id=${result.data.id}`);
  };

  const onConfirmDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    const result = await deleteProduct(pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data} deleted`);
    // The last row of a later page: step back rather than show an empty page.
    if (products.length === 1 && page > 1) setPage(page - 1);
    else await reload();
  };

  const columns: Column<AdminProduct>[] = [
    {
      id: "product",
      header: "Product",
      sortValue: (product) => product.name,
      cell: (product) => (
        <span className="flex items-center gap-2.5">
          <span className="h-10 w-8 shrink-0 overflow-hidden rounded-[2px] bg-admin-raised">
            {product.images[0] ? (
              // A plain img: product images can be any host the admin pasted,
              // and next/image would reject one not in remotePatterns.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={product.images[0]} alt="" className="h-full w-full object-cover" />
            ) : null}
          </span>
          <span className="min-w-0">
            <Link
              href={`/admin/products/edit?id=${product.id}`}
              className="block max-w-[14rem] truncate font-medium text-admin-ink hover:text-copper-700"
            >
              {product.name}
            </Link>
            <span className="block text-[0.625rem] text-admin-muted">{product.sku}</span>
          </span>
        </span>
      ),
    },
    {
      id: "category",
      header: "Category",
      hideBelow: "md",
      sortValue: (product) => product.category,
      cell: (product) => (
        <span className="text-xs text-admin-muted">
          {humanize(product.category)}
          <span className="block text-[0.625rem] text-admin-faint">
            {humanize(product.subcategory)}
          </span>
        </span>
      ),
    },
    {
      id: "price",
      header: "Price",
      align: "right",
      sortValue: (product) => product.price,
      cell: (product) => (
        <span className="whitespace-nowrap tabular-nums">{formatPrice(product.price)}</span>
      ),
    },
    {
      id: "discount",
      header: "Disc.",
      align: "right",
      hideBelow: "lg",
      sortValue: (product) => product.discount,
      cell: (product) =>
        product.discount > 0 ? (
          <span className="tabular-nums text-[#9c4a24]">{product.discount}%</span>
        ) : (
          <span className="text-admin-faint">—</span>
        ),
    },
    {
      id: "stock",
      header: "Stock",
      align: "right",
      sortValue: (product) => product.stock,
      cell: (product) => {
        const available = Math.max(0, product.stock - product.reservedStock);
        const low = available > 0 && available <= product.lowStockThreshold;
        return (
          <span
            className={cn(
              "tabular-nums",
              available === 0 ? "text-[#a32424]" : low ? "text-[#8a5d00]" : "text-admin-ink",
            )}
          >
            {available}
            {product.reservedStock > 0 ? (
              <span className="block text-[0.625rem] text-admin-faint">
                {product.reservedStock} held
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      sortValue: (product) => product.status,
      cell: (product) => <DomainStatus domain="product" status={product.status} />,
    },
    {
      id: "flags",
      header: "Flags",
      hideBelow: "xl",
      cell: (product) => {
        const flags = [
          product.isNew && "New",
          product.isTrending && "Trending",
          product.isBestSeller && "Best",
          product.isFeatured && "Featured",
        ].filter(Boolean) as string[];

        return flags.length === 0 ? (
          <span className="text-admin-faint">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {flags.map((entry) => (
              <span
                key={entry}
                className="rounded-[2px] bg-admin-raised px-1.5 py-0.5 text-[0.5625rem] text-admin-muted ring-1 ring-inset ring-admin-border"
              >
                {entry}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      id: "created",
      header: "Created",
      hideBelow: "xl",
      sortValue: (product) => product.createdAt,
      cell: (product) => (
        <span className="whitespace-nowrap text-[0.6875rem] text-admin-muted">
          {formatDate(product.createdAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (product) => (
        <span className="flex items-center justify-end gap-0.5">
          {/*
            Always a live link now. The storefront renders product pages on
            request from the database, so a product created a moment ago has
            a page — which is what the disabled state here used to cover.
          */}
          <Link
            href={`/product/${product.id}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View ${product.name} on the storefront`}
            title="View on storefront"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
          >
            <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Link>

          <Link
            href={`/admin/products/edit?id=${product.id}`}
            aria-label={`Edit ${product.name}`}
            title="Edit"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Link>

          <button
            type="button"
            onClick={() => void onDuplicate(product)}
            disabled={busy}
            aria-label={`Duplicate ${product.name}`}
            title="Duplicate"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink disabled:opacity-40"
          >
            <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>

          <button
            type="button"
            onClick={() => setPendingDelete(product)}
            aria-label={`Delete ${product.name}`}
            title="Delete"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424]"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Products"
        description="Every product in the catalogue, drafts included."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Products" }]}
        actions={
          <AdminButtonLink href="/admin/products/new" variant="primary">
            <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
            Add product
          </AdminButtonLink>
        }
      />

      <StatusTabs
        label="Filter products by status"
        value={status}
        onChange={(next) => setFilters({ status: next === "all" ? "" : next })}
        tabs={STATUSES.map((value) => ({
          value,
          label: value === "all" ? "All" : humanize(value),
          count: counts?.[value],
        }))}
      />

      {/* --------------------------------------------------- search + filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <IdFilter
          entity="product"
          label="Product ID or SKU"
          value={filters.q}
          onChange={(q) => setFilters({ q })}
          className="w-60"
        />

        <FilterSelect
          label="Filter by category"
          value={filters.category}
          onChange={(category) => setFilters({ category })}
          options={[
            { value: "", label: "All categories" },
            ...categories,
            // Keep a category from the address bar selectable before the list arrives.
            ...(filters.category && !categories.some((option) => option.value === filters.category)
              ? [{ value: filters.category, label: humanize(filters.category) }]
              : []),
          ]}
        />

        <FilterSelect
          label="Filter by brand"
          value={filters.brand}
          onChange={(brand) => setFilters({ brand })}
          options={[
            { value: "", label: "All brands" },
            ...[...new Set([...brands, ...(filters.brand ? [filters.brand] : [])])].map((option) => ({
              value: option,
              label: option,
            })),
          ]}
        />

        <FilterSelect
          label="Filter by stock level"
          value={stock}
          onChange={(next) => setFilters({ stock: next })}
          options={[
            { value: "", label: "Any stock" },
            { value: "in-stock", label: "In stock" },
            { value: "low-stock", label: "Low stock" },
            { value: "out-of-stock", label: "Out of stock" },
          ]}
        />

        <FilterSelect
          label="Filter by merchandising flag"
          value={flag}
          onChange={(next) => setFilters({ flag: next })}
          options={[
            { value: "", label: "Any flag" },
            { value: "isNew", label: "New arrival" },
            { value: "isTrending", label: "Trending" },
            { value: "isBestSeller", label: "Best seller" },
            { value: "isFeatured", label: "Featured" },
          ]}
        />

        <FilterSelect
          label="Sort products"
          value={sort}
          onChange={(next) => setFilters({ sort: next })}
          options={[
            { value: "", label: "Recommended" },
            ...SORTS,
          ]}
        />

        <FilterSelect
          label="Rows per page"
          value={String(pageSize)}
          onChange={(next) => setPageSize(Number(next))}
          options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} per page` }))}
        />

        {filtered || sort ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <DataTable
        rows={products}
        columns={columns}
        getRowId={(product) => product.id}
        isLoading={isLoading && !data}
        className={cn(isRefreshing && "opacity-60")}
        sort={tableSort(sort)}
        onSortChange={(next) => setFilters({ sort: COLUMN_SORTS[next.columnId]?.[next.direction] ?? "" })}
        pagination={
          data
            ? { ...data.pagination, onPageChange: setPage }
            : { page, pageSize, total: 0, totalPages: 1, onPageChange: setPage }
        }
        emptyTitle={filtered ? "No products match" : "No products yet"}
        emptyDescription={
          filtered ? "Adjust the Product ID or filters above, or add a new product." : "Add your first product to start selling."
        }
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete product?"
        loading={busy}
        confirmLabel="Delete product"
        message={
          <>
            Are you sure you want to delete{" "}
            <strong className="text-admin-ink">{pendingDelete?.name}</strong>? It will be removed
            from the storefront immediately. This cannot be undone.
          </>
        }
        onConfirm={() => void onConfirmDelete()}
      />
    </div>
  );
}
