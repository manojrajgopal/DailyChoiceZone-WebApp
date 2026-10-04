"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";

import type { Collection } from "@/types";

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
import { IdMultiSelect } from "@/components/common/IdMultiSelect";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { slugify } from "@/lib/utils/format";
import {
  deleteCollection,
  listCollections,
  saveCollection,
} from "@/services/admin/collectionAdminService";
import { toast } from "@/store/toastStore";

function emptyCollection(): Collection {
  return {
    id: `col_${Date.now()}`,
    slug: "",
    name: "",
    description: "",
    image: "",
    productIds: [],
    featured: true,
  };
}

/**
 * Collection management.
 *
 * Membership is curated rather than computed — that is the whole point of a
 * collection, as opposed to a category. The picker below is therefore the main
 * event: products are added by Product ID or SKU (docs/id-lookup.md), so the
 * editor never downloads the catalogue to search it by name.
 */
export function AdminCollectionsView() {
  const collections = useAdminResource(() => listCollections(), []);

  const [editing, setEditing] = useState<Collection | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Collection | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = collections.data ?? [];

  const onSave = async () => {
    if (!editing) return;
    setSaving(true);
    const result = await saveCollection(editing);
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data.name} saved`);
    setEditing(null);
    await collections.reload();
  };

  const onDelete = async () => {
    if (!pendingDelete) return;
    setSaving(true);
    const result = await deleteCollection(pendingDelete.id);
    setSaving(false);
    setPendingDelete(null);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data} deleted`);
    await collections.reload();
  };

  const columns: Column<Collection>[] = [
    {
      id: "name",
      header: "Collection",
      sortValue: (collection) => collection.name,
      cell: (collection) => (
        <span className="flex items-center gap-2.5">
          <span className="h-9 w-14 shrink-0 overflow-hidden rounded-[2px] bg-admin-raised">
            {collection.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={collection.image} alt="" className="h-full w-full object-cover" />
            ) : null}
          </span>
          <span className="min-w-0">
            <span className="block font-medium text-admin-ink">{collection.name}</span>
            <span className="block text-[0.625rem] text-admin-faint">/{collection.slug}</span>
          </span>
        </span>
      ),
    },
    {
      id: "description",
      header: "Description",
      hideBelow: "lg",
      cell: (collection) => (
        <span className="block max-w-[22rem] truncate text-xs text-admin-muted">
          {collection.description}
        </span>
      ),
    },
    {
      id: "products",
      header: "Products",
      align: "right",
      sortValue: (collection) => collection.productIds.length,
      cell: (collection) => (
        <span className="tabular-nums">{collection.productIds.length}</span>
      ),
    },
    {
      id: "featured",
      header: "Homepage",
      cell: (collection) =>
        collection.featured ? (
          <StatusBadge tone="good">Featured</StatusBadge>
        ) : (
          <StatusBadge tone="neutral">Hidden</StatusBadge>
        ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (collection) => (
        <span className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            onClick={() => setEditing({ ...collection })}
            aria-label={`Edit ${collection.name}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => setPendingDelete(collection)}
            aria-label={`Delete ${collection.name}`}
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
        title="Collections"
        description="Curated edits — hand-picked groups of products, shown on the homepage and their own pages."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Collections" }]}
        actions={
          <AdminButton
            variant="primary"
            onClick={() => setEditing(emptyCollection())}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
            Add collection
          </AdminButton>
        }
      />

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(collection) => collection.id}
        isLoading={collections.isLoading}
        pageSize={12}
        emptyTitle="No collections yet"
        emptyDescription="Create one to group products into an edit."
      />

      {/* --------------------------------------------------------- editor */}
      <Modal
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing?.name ? `Edit ${editing.name}` : "Add collection"}
        className="max-w-2xl"
      >
        {editing ? (
          <div className="flex flex-col gap-4">
            <FormGrid>
              <AdminInput
                label="Name"
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                required
              />

              <AdminInput
                label="Web address"
                value={editing.slug}
                onChange={(event) => setEditing({ ...editing, slug: event.target.value })}
                hint={`/collection/${editing.slug || slugify(editing.name) || "…"}`}
              />

              <AdminTextarea
                label="Description"
                rows={2}
                value={editing.description}
                onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                className="sm:col-span-2"
              />

              <AdminInput
                label="Banner image URL"
                type="url"
                value={editing.image}
                onChange={(event) => setEditing({ ...editing, image: event.target.value })}
                className="sm:col-span-2"
              />
            </FormGrid>

            <AdminCheckbox
              label="Feature on the homepage"
              description="Appears in the Featured collections grid."
              checked={editing.featured}
              onChange={(event) => setEditing({ ...editing, featured: event.target.checked })}
            />

            {/* ------------------------------------------- product picker */}
            <div>
              <p className="mb-1.5 text-xs font-medium text-admin-ink">
                Products in this collection
                <span className="ml-1.5 font-normal text-admin-muted tabular-nums">
                  ({editing.productIds.length} selected)
                </span>
              </p>

              <IdMultiSelect
                entity="product"
                label="Add a product — Product ID or SKU"
                placeholder="Search Product ID or SKU…"
                values={editing.productIds}
                onChange={(productIds) => setEditing({ ...editing, productIds })}
                emptyText="No products yet. Add them by Product ID or SKU."
              />
            </div>

            <div className="flex justify-end gap-2">
              <AdminButton variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </AdminButton>
              <AdminButton variant="primary" loading={saving} onClick={() => void onSave()}>
                Save collection
              </AdminButton>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Delete collection?"
        loading={saving}
        confirmLabel="Delete collection"
        message={
          <>
            Delete <strong className="text-admin-ink">{pendingDelete?.name}</strong>? The products
            in it are not affected — only the grouping is removed. This cannot be undone.
          </>
        }
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
