"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Copy, Eye, EyeOff, Pencil, Plus, Search, Trash2, X } from "lucide-react";

import type { AdminProduct, ProductStatus } from "@/types/admin";

import {
  AdminButton,
  AdminButtonLink,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { hasStorefrontPage } from "@/lib/admin/catalogue";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice, humanize } from "@/lib/utils/format";
import { currentActorId } from "@/services/admin/adminAuthService";
import {
  deleteProduct,
  duplicateProduct,
  listProducts,
} from "@/services/admin/productAdminService";
import { toast } from "@/store/toastStore";

type StockFilter = "all" | "in-stock" | "low-stock" | "out-of-stock";
type FlagFilter = "all" | "isNew" | "isTrending" | "isBestSeller" | "isFeatured";

const STATUSES: (ProductStatus | "all")[] = ["all", "active", "draft", "out-of-stock", "archived"];

/**
 * The product list.
 *
 * Filtering happens here and the result is handed to the shared `DataTable`,
 * which owns sorting, paging and selection. The split is deliberate: filter
 * controls differ on every list page, the table mechanics do not.
 */
export function AdminProductsView() {
  const router = useRouter();
  const { data, isLoading, reload } = useAdminResource(() => listProducts(), []);

  const [term, setTerm] = useState("");
  const [status, setStatus] = useState<ProductStatus | "all">("all");
  const [category, setCategory] = useState("all");
  const [brand, setBrand] = useState("all");
  const [stock, setStock] = useState<StockFilter>("all");
  const [flag, setFlag] = useState<FlagFilter>("all");

  const [pendingDelete, setPendingDelete] = useState<AdminProduct | null>(null);
  const [busy, setBusy] = useState(false);

  const products = data ?? [];

  const categories = useMemo(
    () => [...new Set(products.map((product) => product.category))].sort(),
    [products],
  );
  const brands = useMemo(
    () => [...new Set(products.map((product) => product.brand))].sort(),
    [products],
  );

  const filtered = useMemo(() => {
    const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);

    return products.filter((product) => {
      if (status !== "all" && product.status !== status) return false;
      if (category !== "all" && product.category !== category) return false;
      if (brand !== "all" && product.brand !== brand) return false;

      if (stock !== "all") {
        const available = Math.max(0, product.stock - product.reservedStock);
        const isOut = available <= 0;
        const isLow = !isOut && available <= product.lowStockThreshold;
        if (stock === "out-of-stock" && !isOut) return false;
        if (stock === "low-stock" && !isLow) return false;
        if (stock === "in-stock" && (isOut || isLow)) return false;
      }

      if (flag !== "all" && !product[flag]) return false;

      if (terms.length > 0) {
        // Search the fields an administrator actually has to hand: a name from
        // a support call, a SKU from a supplier, a brand or category.
        const haystack = [
          product.name,
          product.sku,
          product.brand,
          product.category,
          product.subcategory,
          product.barcode,
        ]
          .join(" ")
          .toLowerCase();
        if (!terms.every((token) => haystack.includes(token))) return false;
      }

      return true;
    });
  }, [products, term, status, category, brand, stock, flag]);

  const activeFilters =
    (status !== "all" ? 1 : 0) +
    (category !== "all" ? 1 : 0) +
    (brand !== "all" ? 1 : 0) +
    (stock !== "all" ? 1 : 0) +
    (flag !== "all" ? 1 : 0);

  const clearFilters = () => {
    setStatus("all");
    setCategory("all");
    setBrand("all");
    setStock("all");
    setFlag("all");
    setTerm("");
  };

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
    await reload();
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
          {hasStorefrontPage(product.slug) ? (
            <Link
              href={`/product/${product.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`View ${product.name} on the storefront`}
              title="View on storefront"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
            >
              <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
            </Link>
          ) : (
            <span
              title="No storefront page yet — this product was added after the last site build"
              aria-label={`${product.name} has no storefront page until the next build`}
              className="inline-flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-[3px] text-admin-border-strong"
            >
              <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            </span>
          )}

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

  const selectClass =
    "h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink hover:border-admin-border-strong focus:border-copper-500";

  return (
    <div>
      <AdminPageHeader
        title="Products"
        description={`${products.length} products in the catalogue.`}
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Products" }]}
        actions={
          <AdminButtonLink href="/admin/products/new" variant="primary">
            <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
            Add product
          </AdminButtonLink>
        }
      />

      {/* --------------------------------------------------- search + filters */}
      <div className="mb-4 rounded-[3px] border border-admin-border bg-admin-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="product-search" className="sr-only">
              Search products by name, SKU, brand or category
            </label>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <input
              id="product-search"
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Name, SKU, brand…"
              className="h-8 w-full rounded-[3px] border border-admin-border bg-admin-raised pl-8 pr-2 text-xs text-admin-ink placeholder:text-admin-faint focus:border-copper-500 focus:bg-admin-surface"
            />
          </div>

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as ProductStatus | "all")}
            aria-label="Filter by status"
            className={selectClass}
          >
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {option === "all" ? "All statuses" : humanize(option)}
              </option>
            ))}
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

          <select
            value={brand}
            onChange={(event) => setBrand(event.target.value)}
            aria-label="Filter by brand"
            className={selectClass}
          >
            <option value="all">All brands</option>
            {brands.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>

          <select
            value={stock}
            onChange={(event) => setStock(event.target.value as StockFilter)}
            aria-label="Filter by stock level"
            className={selectClass}
          >
            <option value="all">Any stock</option>
            <option value="in-stock">In stock</option>
            <option value="low-stock">Low stock</option>
            <option value="out-of-stock">Out of stock</option>
          </select>

          <select
            value={flag}
            onChange={(event) => setFlag(event.target.value as FlagFilter)}
            aria-label="Filter by merchandising flag"
            className={selectClass}
          >
            <option value="all">Any flag</option>
            <option value="isNew">New arrival</option>
            <option value="isTrending">Trending</option>
            <option value="isBestSeller">Best seller</option>
            <option value="isFeatured">Featured</option>
          </select>

          {activeFilters > 0 || term ? (
            <AdminButton size="sm" variant="ghost" onClick={clearFilters}>
              <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              Clear filters
            </AdminButton>
          ) : null}
        </div>

        <p className="mt-2.5 text-[0.6875rem] text-admin-muted tabular-nums">
          {isLoading ? "Loading…" : `${filtered.length} of ${products.length} products shown`}
        </p>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(product) => product.id}
        isLoading={isLoading}
        pageSize={12}
        initialSort={{ columnId: "created", direction: "desc" }}
        emptyTitle="No products match"
        emptyDescription="Adjust the search or filters above, or add a new product."
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
