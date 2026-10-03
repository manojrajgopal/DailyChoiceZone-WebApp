"use client";

import { useState } from "react";
import { Archive, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { LogSearch, StatusTabs, useUrlFilters } from "@/components/admin/ui/LogPage";
import { Badge, TD, TH, TableState } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { deleteAttribute, listAttributes, updateAttribute } from "@/services/admin/searchAdminService";
import { toast } from "@/store/toastStore";
import type { ProductAttribute } from "@/types/searchAdmin";

import { AttributeDialog } from "./AttributeDialog";
import { ADMIN_CRUMB, NoAccess, TYPE_LABELS, count, friendlyError, isForbidden } from "./shared";

const KEYS = ["q", "status"] as const;
const STATUSES = ["active", "archived", "all"] as const;
type StatusTab = (typeof STATUSES)[number];

const ICON_BUTTON =
  "inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Catalogue → Attributes: the product properties shoppers filter and search
 * by (material, sleeve length, battery capacity…). The list is small, so it is
 * read whole and the tabs and search work on it here.
 */
export function AdminAttributesView() {
  const { filters, setFilters, clear } = useUrlFilters(KEYS);
  const status: StatusTab = (STATUSES as readonly string[]).includes(filters.status)
    ? (filters.status as StatusTab)
    : "active";
  const attributes = useAdminResource(() => listAttributes("all"), []);
  const all = attributes.data ?? [];

  const [editing, setEditing] = useState<ProductAttribute | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProductAttribute | null>(null);
  const [busy, setBusy] = useState("");

  const terms = filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = all.filter(
    (row) =>
      (status === "all" || row.status === status) &&
      terms.every((term) => `${row.label} ${row.code}`.toLowerCase().includes(term)),
  );
  const counts = attributes.data
    ? {
        active: all.filter((row) => row.status === "active").length,
        archived: all.filter((row) => row.status === "archived").length,
        all: all.length,
      }
    : undefined;

  const setArchived = async (row: ProductAttribute, archived: boolean) => {
    setBusy(`status-${row.id}`);
    try {
      await updateAttribute(row.id, { status: archived ? "archived" : "active" });
      toast.success(archived ? `${row.label} archived` : `${row.label} restored`);
      await attributes.reload();
    } catch (error) {
      toast.error(friendlyError(error, "That didn't save. Please try again."));
    } finally {
      setBusy("");
    }
  };

  const onDelete = async () => {
    if (!deleting) return;
    setBusy(`delete-${deleting.id}`);
    try {
      await deleteAttribute(deleting.id);
      toast.success(`${deleting.label} deleted`);
      setDeleting(null);
      await attributes.reload();
    } catch (error) {
      // ATTRIBUTE_IN_USE: the server explains, and says to archive instead.
      toast.error(friendlyError(error, "The attribute wasn't deleted. Please try again."));
      setDeleting(null);
    } finally {
      setBusy("");
    }
  };

  const onSaved = async () => {
    setCreating(false);
    setEditing(null);
    await attributes.reload();
  };

  if (isForbidden(attributes.error)) {
    return (
      <div>
        <AdminPageHeader title="Attributes" breadcrumbs={[ADMIN_CRUMB, { label: "Attributes" }]} />
        <NoAccess permission="products" />
      </div>
    );
  }

  const filtered = Boolean(filters.q || status !== "active");

  return (
    <div>
      <AdminPageHeader
        title="Attributes"
        description="Product properties shoppers can filter and search by. Set each product's values on its edit page."
        breadcrumbs={[ADMIN_CRUMB, { label: "Attributes" }]}
        actions={
          <AdminButton size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            New attribute
          </AdminButton>
        }
      />

      <StatusTabs
        label="Filter attributes by status"
        value={status}
        onChange={(next) => setFilters({ status: next === "active" ? "" : next })}
        tabs={[
          { value: "active", label: "Active", count: counts?.active },
          { value: "archived", label: "Archived", count: counts?.archived },
          { value: "all", label: "All", count: counts?.all },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LogSearch label="Search attributes" value={filters.q} onChange={(q) => setFilters({ q })} placeholder="Label or code" />
        {filtered ? (
          <AdminButton size="sm" variant="ghost" onClick={clear}>
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Clear filters
          </AdminButton>
        ) : null}
      </div>

      <AdminCard padded={false}>
        <div className="overflow-x-auto">
          <table className={cn("w-full min-w-[52rem] text-left text-xs", attributes.isRefreshing && "opacity-60")}>
            <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
              <tr>
                <th className={TH}>Attribute</th>
                <th className={TH}>Type</th>
                <th className={TH}>Options</th>
                <th className={TH}>Used for</th>
                <th className={cn(TH, "text-right")}>Position</th>
                <th className={cn(TH, "text-right")}>Products</th>
                <th className={TH}>Status</th>
                <th className={cn(TH, "text-right")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-admin-border">
              <TableState
                columns={8}
                loading={attributes.isLoading && !attributes.data}
                failed={Boolean(attributes.error && !attributes.data)}
                empty={Boolean(attributes.data && rows.length === 0)}
                onRetry={() => void attributes.reload()}
                title={filtered ? "No attributes match" : "No attributes yet"}
                hint={filtered ? "Try a different search or status." : "Create one, e.g. Material or Sleeve length."}
              />
              {rows.map((row) => (
                <tr key={row.id} className="align-top hover:bg-admin-raised">
                  <td className={TD}>
                    <button
                      type="button"
                      onClick={() => setEditing(row)}
                      className="block text-left font-medium text-admin-ink hover:text-copper-700"
                    >
                      {row.label}
                    </button>
                    <span className="block font-mono text-[0.6875rem] text-admin-faint">{row.code}</span>
                  </td>
                  <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>
                    {TYPE_LABELS[row.type] ?? row.type}
                    {row.unit ? <span className="text-admin-faint"> · {row.unit}</span> : null}
                  </td>
                  <td className={cn(TD, "text-admin-muted")}>
                    {row.type === "select" || row.type === "multi" ? (
                      <span className="block max-w-[16rem] truncate" title={row.options.map((o) => o.label).join(", ")}>
                        {row.options.length === 0
                          ? "None yet"
                          : `${row.options.length}: ${row.options.slice(0, 4).map((o) => o.label).join(", ")}${row.options.length > 4 ? "…" : ""}`}
                      </span>
                    ) : (
                      <span className="text-admin-faint">—</span>
                    )}
                  </td>
                  <td className={TD}>
                    <span className="flex flex-wrap gap-1">
                      {row.filterable ? <Badge tone="green">Filter</Badge> : null}
                      {row.searchable ? <Badge tone="green">Search</Badge> : null}
                      {!row.filterable && !row.searchable ? <Badge tone="grey">Display only</Badge> : null}
                    </span>
                  </td>
                  <td className={cn(TD, "text-right tabular-nums text-admin-muted")}>{row.position}</td>
                  <td className={cn(TD, "text-right font-medium tabular-nums text-admin-ink")}>{count(row.productCount)}</td>
                  <td className={TD}>
                    <Badge tone={row.status === "active" ? "green" : "grey"}>
                      {row.status === "active" ? "Active" : "Archived"}
                    </Badge>
                  </td>
                  <td className={cn(TD, "text-right")}>
                    <span className="inline-flex items-center gap-0.5">
                      <button type="button" className={ICON_BUTTON} onClick={() => setEditing(row)} aria-label={`Edit ${row.label}`} title="Edit">
                        <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      </button>
                      {row.status === "active" ? (
                        <button
                          type="button"
                          className={ICON_BUTTON}
                          onClick={() => void setArchived(row, true)}
                          disabled={busy === `status-${row.id}`}
                          aria-label={`Archive ${row.label}`}
                          title="Archive: hide it from filters and product forms"
                        >
                          <Archive className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={ICON_BUTTON}
                          onClick={() => void setArchived(row, false)}
                          disabled={busy === `status-${row.id}`}
                          aria-label={`Restore ${row.label}`}
                          title="Restore"
                        >
                          <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className={cn(ICON_BUTTON, "hover:bg-[#fbeaea] hover:text-[#a32424]")}
                        onClick={() => setDeleting(row)}
                        aria-label={`Delete ${row.label}`}
                        title={row.productCount > 0 ? "Products use this attribute: archive it instead" : "Delete"}
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AttributeDialog
        open={creating || editing !== null}
        attribute={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        onSaved={() => void onSaved()}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={deleting && deleting.productCount > 0 ? "Attribute in use" : "Delete attribute?"}
        confirmLabel={deleting && deleting.productCount > 0 ? (deleting.status === "active" ? "Archive instead" : "Close") : "Delete attribute"}
        destructive={!(deleting && deleting.productCount > 0)}
        loading={Boolean(deleting && (busy === `delete-${deleting.id}` || busy === `status-${deleting.id}`))}
        message={
          deleting && deleting.productCount > 0 ? (
            <>
              <strong className="text-admin-ink">{deleting.label}</strong> is set on {count(deleting.productCount)}{" "}
              {deleting.productCount === 1 ? "product" : "products"}, so it can&apos;t be deleted.{" "}
              {deleting.status === "active"
                ? "Archive it instead to hide it from filters and product forms."
                : "It stays archived, hidden from filters and product forms."}
            </>
          ) : (
            <>
              Delete <strong className="text-admin-ink">{deleting?.label}</strong> and its options? This can&apos;t be
              undone.
            </>
          )
        }
        onConfirm={() => {
          if (deleting && deleting.productCount > 0) {
            const row = deleting;
            setDeleting(null);
            if (row.status === "active") void setArchived(row, true);
          } else void onDelete();
        }}
      />
    </div>
  );
}
