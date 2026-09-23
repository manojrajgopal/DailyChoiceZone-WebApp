"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";

import type { AdminHomeSection, HomeSectionKind } from "@/types/admin";

import {
  AdminButton,
  AdminCard,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, FormGrid } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { Modal } from "@/components/ui/Dialog";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import {
  SECTION_KINDS,
  SECTION_SOURCES,
  deleteSection,
  emptySection,
  getSections,
  moveSection,
  saveSection,
  toggleSection,
} from "@/services/admin/homepageAdminService";
import { toast } from "@/store/toastStore";

import Link from "next/link";

/**
 * Homepage composition.
 *
 * The storefront homepage renders whatever this list describes, in this order —
 * there is no hardcoded layout to keep in step. Reordering, retitling, hiding
 * and adding sections all happen here.
 */
export function AdminHomepageView() {
  const sections = useAdminResource(() => getSections(), []);

  const [editing, setEditing] = useState<AdminHomeSection | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AdminHomeSection | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = sections.data ?? [];
  const activeCount = rows.filter((section) => section.active).length;

  const kindLabel = (type: HomeSectionKind) =>
    SECTION_KINDS.find((entry) => entry.value === type)?.label ?? type;

  const needsSource = (type: HomeSectionKind) =>
    SECTION_KINDS.find((entry) => entry.value === type)?.needsSource ?? false;

  const onMove = async (id: string, direction: "up" | "down") => {
    setBusy(true);
    await moveSection(id, direction);
    setBusy(false);
    await sections.reload();
  };

  const onToggle = async (section: AdminHomeSection) => {
    setBusy(true);
    await toggleSection(section.id);
    setBusy(false);
    toast.success(`${section.title} ${section.active ? "hidden" : "shown"} on the homepage`);
    await sections.reload();
  };

  const onSave = async () => {
    if (!editing) return;
    setBusy(true);
    const result = await saveSection(editing);
    setBusy(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data.title} saved`);
    setEditing(null);
    await sections.reload();
  };

  const onDelete = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    const result = await deleteSection(pendingDelete.id);
    setBusy(false);
    setPendingDelete(null);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`${result.data} removed from the homepage`);
    await sections.reload();
  };

  return (
    <div>
      <AdminPageHeader
        title="Homepage"
        description="The sections that make up the storefront homepage, in the order they appear."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Homepage" }]}
        actions={
          <span className="flex items-center gap-2">
            <Link
              href="/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-[3px] border border-admin-border-strong px-3 text-[0.8125rem] text-admin-ink transition-colors hover:bg-admin-raised"
            >
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              Preview
            </Link>
            <AdminButton
              variant="primary"
              onClick={() => setEditing(emptySection(rows.length + 1))}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden="true" />
              Add section
            </AdminButton>
          </span>
        }
      />

      <AdminCard
        title={`${rows.length} sections · ${activeCount} live`}
        description="Drag is not supported; use the arrows to reorder."
        padded={false}
      >
        {sections.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="h-16 animate-pulse rounded-[3px] bg-admin-raised" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-admin-muted">
            No sections yet. Add one to build the homepage.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-admin-border">
            {rows.map((section, index) => (
              <li
                key={section.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 px-4 py-3",
                  !section.active && "bg-admin-raised/60",
                )}
              >
                {/* ------------------------------------------ reorder */}
                <span className="flex shrink-0 flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => void onMove(section.id, "up")}
                    disabled={index === 0 || busy}
                    aria-label={`Move ${section.title} up`}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] text-admin-muted transition-colors hover:bg-admin-border hover:text-admin-ink disabled:opacity-25"
                  >
                    <ArrowUp className="h-3 w-3" strokeWidth={2.25} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void onMove(section.id, "down")}
                    disabled={index === rows.length - 1 || busy}
                    aria-label={`Move ${section.title} down`}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-[2px] text-admin-muted transition-colors hover:bg-admin-border hover:text-admin-ink disabled:opacity-25"
                  >
                    <ArrowDown className="h-3 w-3" strokeWidth={2.25} />
                  </button>
                </span>

                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[3px] bg-admin-raised text-xs font-semibold text-admin-muted tabular-nums">
                  {section.displayOrder}
                </span>

                {/* ------------------------------------------- detail */}
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-sm font-medium",
                      section.active ? "text-admin-ink" : "text-admin-muted",
                    )}
                  >
                    {section.title}
                  </span>
                  <span className="block text-[0.6875rem] text-admin-muted">
                    {kindLabel(section.type)}
                    {section.source ? ` · ${section.source}` : ""}
                    {needsSource(section.type) ? ` · ${section.limit} products` : ""}
                  </span>
                </span>

                {section.active ? (
                  <StatusBadge tone="good">Live</StatusBadge>
                ) : (
                  <StatusBadge tone="neutral">Hidden</StatusBadge>
                )}

                {/* ------------------------------------------ actions */}
                <span className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => void onToggle(section)}
                    disabled={busy}
                    aria-label={
                      section.active ? `Hide ${section.title}` : `Show ${section.title}`
                    }
                    title={section.active ? "Hide" : "Show"}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink disabled:opacity-40"
                  >
                    {section.active ? (
                      <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                    ) : (
                      <EyeOff className="h-3.5 w-3.5" strokeWidth={1.75} />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => setEditing({ ...section })}
                    aria-label={`Edit ${section.title}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-admin-raised hover:text-admin-ink"
                  >
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>

                  <button
                    type="button"
                    onClick={() => setPendingDelete(section)}
                    aria-label={`Remove ${section.title}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-admin-muted transition-colors hover:bg-[#fbeaea] hover:text-[#a32424]"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </AdminCard>

      <p className="mt-3 rounded-[3px] border border-admin-border bg-admin-surface px-3 py-2.5 text-[0.6875rem] leading-relaxed text-admin-muted">
        Hiding a section keeps its configuration — use it to take a rail down temporarily rather
        than deleting and rebuilding it. Sections whose source has no products are skipped on the
        storefront rather than rendering an empty heading.
      </p>

      {/* --------------------------------------------------------- editor */}
      <Modal
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.title ? `Edit ${editing.title}` : "Add section"}
        className="max-w-lg"
      >
        {editing ? (
          <div className="flex flex-col gap-4">
            <FormGrid>
              <AdminSelect
                label="Section type"
                value={editing.type}
                onChange={(event) => {
                  const type = event.target.value as HomeSectionKind;
                  setEditing({
                    ...editing,
                    type,
                    // A layout-only section has no product source to keep.
                    source: needsSource(type) ? (editing.source ?? "new-arrivals") : null,
                  });
                }}
                options={SECTION_KINDS.map((entry) => ({
                  value: entry.value,
                  label: entry.label,
                }))}
                className="sm:col-span-2"
              />

              <AdminInput
                label="Title"
                value={editing.title}
                onChange={(event) => setEditing({ ...editing, title: event.target.value })}
                required
                placeholder="New Arrivals"
              />

              <AdminInput
                label="Subtitle"
                value={editing.subtitle}
                onChange={(event) => setEditing({ ...editing, subtitle: event.target.value })}
                placeholder="Just landed this week"
              />

              {needsSource(editing.type) ? (
                <>
                  <AdminSelect
                    label="Products from"
                    value={editing.source ?? ""}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        source: event.target.value as AdminHomeSection["source"],
                      })
                    }
                    options={SECTION_SOURCES.map((entry) => ({
                      value: entry.value,
                      label: entry.label,
                    }))}
                    hint="Which merchandising query feeds this rail."
                  />

                  <AdminInput
                    label="How many to show"
                    type="number"
                    min={1}
                    max={24}
                    value={editing.limit}
                    onChange={(event) =>
                      setEditing({ ...editing, limit: Number(event.target.value) })
                    }
                  />
                </>
              ) : (
                <p className="text-[0.6875rem] leading-relaxed text-admin-muted sm:col-span-2">
                  This section type builds its own content — a category grid uses featured
                  categories, a collection grid uses featured collections.
                </p>
              )}
            </FormGrid>

            <div className="flex justify-end gap-2">
              <AdminButton variant="secondary" onClick={() => setEditing(null)}>
                Cancel
              </AdminButton>
              <AdminButton variant="primary" loading={busy} onClick={() => void onSave()}>
                Save section
              </AdminButton>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title="Remove section?"
        loading={busy}
        confirmLabel="Remove section"
        message={
          <>
            Remove <strong className="text-admin-ink">{pendingDelete?.title}</strong> from the
            homepage? If you only want it gone for now, hide it instead — that keeps the settings.
          </>
        }
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
