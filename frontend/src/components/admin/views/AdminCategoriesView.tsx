"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import type { Category } from "@/types";

import {
  AdminButton,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import {
  AdminCheckbox,
  AdminInput,
  AdminTextarea,
  FormGrid,
} from "@/components/admin/ui/AdminForm";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { slugify } from "@/lib/utils/format";
import {
  countProductsByCategory,
  deleteCategory,
  listCategories,
  saveCategory,
} from "@/services/admin/categoryAdminService";
import { toast } from "@/store/toastStore";

function emptyCategory(order: number): Category {
  return {
    id: `cat_${Date.now()}`,
    slug: "",
    name: "",
    description: "",
    image: "",
    groups: [{ name: "Shop", items: [] }],
    order,
    featured: true,
  };
}

/**
 * Category management.
 *
 * Categories are shared with the storefront verbatim — the same records drive
 * the shop's department pages and mega menu. Deleting one that still has
 * products is refused by the service rather than silently orphaning them.
 */
export function AdminCategoriesView() {
  const categories = useAdminResource(() => listCategories(), []);
  const counts = useAdminResource(() => countProductsByCategory(), []);

  const [editing, setEditing] = useState<Category | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Category | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = categories.data ?? [];
  const productCounts = counts.data ?? {};

  const onSave = async () => {
    if (!editing) return;
    setSaving(true);
    const result = await saveCategory(editing);
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data.name} saved`);
    setEditing(null);
    await Promise.all([categories.reload(), counts.reload()]);
  };

  const onDelete = async () => {
    if (!pendingDelete) return;
    setSaving(true);
    const result = await deleteCategory(pendingDelete.id);
    setSaving(false);
    setPendingDelete(null);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data} deleted`);
    await Promise.all([categories.reload(), counts.reload()]);
  };

  const columns: Column<Category>[] = [
    {
      id: "name",
      header: "Category",
      sortValue: (category) => category.name,
      cell: (category) => (
        <span className="flex items-center gap-2.5">
          <span className="h-9 w-9 shrink-0 overflow-hidden rounded-[2px] bg-admin-raised">
            {category.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={category.image} alt="" className="h-full w-full object-cover" />
            ) : null}
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-admin-ink">{category.name}</span>
            <span className="block text-[0.625rem] text-admin-faint">/{category.slug}</span>
          </span>
        </span>
      ),
    },
    {
      id: "types",
      header: "Product types",
      hideBelow: "md",
      cell: (category) => {
        const items = category.groups.flatMap((group) => group.items);
        return (
          <span className="text-xs text-admin-muted">
            {items.length === 0 ? "None" : `${items.length} types`}
            <span className="block max-w-[16rem] truncate text-[0.625rem] text-admin-faint">
              {items.map((item) => item.name).join(", ")}
            </span>
          </span>
        );
      },
    },
    {
      id: "products",
      header: "Products",
      align: "right",
      sortValue: (category) => productCounts[category.slug] ?? 0,
      cell: (category) => (
        <span className="tabular-nums">{productCounts[category.slug] ?? 0}</span>
      ),
    },
    {
      id: "order",
      header: "Order",
      align: "right",
      hideBelow: "lg",
      sortValue: (category) => category.order,
      cell: (category) => <span className="tabular-nums text-admin-muted">{category.order}</span>,
    },
    {
      id: "featured",
      header: "Homepage",
      cell: (category) =>
        category.featured ? (
          <StatusBadge tone="good">Featured</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Hidden</StatusBadge>
        ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (category) => (
        <span className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            onClick={() => setEditing({ ...category })}
            aria-label={`Edit ${category.name}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => setPendingDelete(category)}
            aria-label={`Delete ${category.name}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424]"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </span>
      ),
    },
  ];

  const inUse = pendingDelete ? (productCounts[pendingDelete.slug] ?? 0) : 0;

  return (
    <div>
      <AdminPageHeader
        title="Categories"
        description="The departments that organise the catalogue and the storefront menu."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Categories" }]}
        actions={
          <AdminButton
            variant="primary"
            onClick={() => setEditing(emptyCategory(rows.length + 1))}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
            Add category
          </AdminButton>
        }
      />

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(category) => category.id}
        isLoading={categories.isLoading}
        pageSize={15}
        initialSort={{ columnId: "order", direction: "asc" }}
        emptyTitle="No categories yet"
        emptyDescription="Add one to start organising the catalogue."
      />

      {/* --------------------------------------------------------- editor */}
      <Modal
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.name ? `Edit ${editing.name}` : "Add category"}
        className="max-w-lg"
      >
        {editing ? (
          <div className="flex flex-col gap-4">
            <FormGrid>
              <AdminInput
                label="Name"
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                required
                className="sm:col-span-2"
              />

              <AdminInput
                label="URL slug"
                value={editing.slug}
                onChange={(event) => setEditing({ ...editing, slug: event.target.value })}
                hint={`Storefront: /category/${editing.slug || slugify(editing.name) || "…"}`}
                className="sm:col-span-2"
              />

              <AdminTextarea
                label="Description"
                rows={3}
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                className="sm:col-span-2"
                hint="Shown on the category banner."
              />

              <AdminInput
                label="Banner image URL"
                type="url"
                value={editing.image}
                onChange={(event) => setEditing({ ...editing, image: event.target.value })}
                className="sm:col-span-2"
              />

              <AdminInput
                label="Display order"
                type="number"
                min={1}
                value={editing.order}
                onChange={(event) => setEditing({ ...editing, order: Number(event.target.value) })}
                hint="Lower numbers appear first."
              />
            </FormGrid>

            <AdminCheckbox
              label="Feature on the homepage"
              description="Appears in the Shop by category grid."
              checked={editing.featured}
              onChange={(event) => setEditing({ ...editing, featured: event.target.checked })}
            />

            <p className="rounded-[3px] bg-admin-raised px-3 py-2 text-[0.6875rem] leading-relaxed text-admin-muted">
              Product types within this category are edited on each product. A category with no
              types still works — its page simply shows everything in it.
            </p>

            <div className="flex justify-end gap-2">
              <AdminButton variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </AdminButton>
              <AdminButton variant="primary" loading={saving} onClick={() => void onSave()}>
                Save category
              </AdminButton>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete category?"
        loading={saving}
        confirmLabel="Delete category"
        message={
          inUse > 0 ? (
            <>
              <strong className="text-admin-ink">{pendingDelete?.name}</strong> still has{" "}
              <strong className="text-admin-ink">{inUse}</strong> product
              {inUse === 1 ? "" : "s"} in it. Move them to another category first — deleting it
              would leave them unreachable on the storefront.
            </>
          ) : (
            <>
              Delete <strong className="text-admin-ink">{pendingDelete?.name}</strong>? It has no
              products, so nothing on the storefront will break. This cannot be undone.
            </>
          )
        }
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
