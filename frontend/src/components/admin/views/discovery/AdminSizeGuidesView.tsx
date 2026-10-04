"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { AdminButton, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import {
  AdminInput,
  AdminSelect,
  AdminTextarea,
  AdminToggle,
  FormGrid,
} from "@/components/admin/ui/AdminForm";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { IdAutocomplete } from "@/components/common/IdAutocomplete";
import { IdMultiSelect } from "@/components/common/IdMultiSelect";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { ApiError } from "@/services/api/client";
import {
  createSizeGuide,
  deleteSizeGuide,
  getSizeGuide,
  listSizeGuides,
  setSizeGuideCategories,
  setSizeGuideProducts,
  updateSizeGuide,
  type AdminSizeGuide,
  type SizeGuideInput,
} from "@/services/admin/discoveryAdminService";
import type { SizeGuideColumn } from "@/services/discoveryService";
import { toast } from "@/store/toastStore";

const KINDS = [
  { value: "clothing", label: "Clothing" },
  { value: "footwear", label: "Footwear" },
  { value: "ring", label: "Rings" },
  { value: "general", label: "General" },
];
const UNITS = [
  { value: "cm", label: "Centimetres (cm)" },
  { value: "in", label: "Inches (in)" },
  { value: "mm", label: "Millimetres (mm)" },
];

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
}

/** A stored cell as the editor shows it: "92", "92-97", or the text itself. */
function cellText(value: { min: number; max?: number } | string | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return value.max !== undefined && value.max !== value.min ? `${value.min}-${value.max}` : String(value.min);
}

function emptyInput(templates: Record<string, SizeGuideColumn[]>, kind: SizeGuideInput["kind"] = "clothing"):
  SizeGuideInput {
  return {
    name: "",
    kind,
    description: "",
    unit: kind === "ring" ? "mm" : "cm",
    columns: (templates[kind] ?? []).map((column) => ({ ...column, required: true })),
    rows: [{ size: "", values: {} }],
    instructions: [],
    notes: "",
    status: "active",
    isDefault: false,
  };
}

function toInput(guide: AdminSizeGuide): SizeGuideInput {
  return {
    name: guide.name,
    kind: guide.kind,
    description: guide.description,
    unit: guide.unit,
    columns: guide.columns.map((column) => ({ ...column, required: column.required !== false })),
    rows: guide.rows.map((row) => ({
      size: row.size,
      values: Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, cellText(value)])),
    })),
    instructions: guide.instructions,
    notes: guide.notes,
    status: guide.status,
    isDefault: guide.isDefault,
  };
}

/**
 * Size guides, in the portal: the tables products show from their size
 * picker. One guide serves many products — assign it to categories (their
 * default) or to products directly (overriding the category's).
 */
export function AdminSizeGuidesView() {
  const [filter, setFilter] = useState({ q: "", status: "" });
  const list = useAdminResource(() => listSizeGuides(filter), [filter.q, filter.status]);
  const [editing, setEditing] = useState<string | "new" | null>(null);

  return (
    <div>
      <AdminPageHeader
        title="Size guides"
        description="Size tables for clothing, footwear, rings or anything else, in cm, inches or mm. Shoppers can switch units on the product page."
        breadcrumbs={[{ label: "Catalogue", href: "/admin/products" }, { label: "Size guides" }]}
        actions={
          <AdminButton variant="primary" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New size guide
          </AdminButton>
        }
      />

      <div className="grid items-start gap-5 xl:grid-cols-[22rem_1fr]">
        <AdminCard padded={false}>
          <div className="flex flex-col gap-2 border-b border-admin-border p-3">
            <IdFilter
              entity="size_guide"
              value={filter.q}
              onChange={(q) => setFilter((current) => ({ ...current, q }))}
            />
            <AdminSelect
              label="Status"
              value={filter.status}
              onChange={(event) => setFilter((current) => ({ ...current, status: event.target.value }))}
              options={[{ value: "", label: "All" }, { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" }]}
            />
          </div>
          {list.error && !list.data ? (
            <div role="alert" className="p-4 text-xs text-admin-ink">
              {message(list.error, "The size guides didn't load.")}
              <AdminButton size="sm" className="ml-2" onClick={() => void list.reload()}>Try again</AdminButton>
            </div>
          ) : !list.data ? (
            <div aria-busy="true" aria-label="Loading size guides" className="flex flex-col gap-2 p-4">
              <span className="block h-4 w-full animate-pulse rounded-[2px] bg-admin-border" />
              <span className="block h-4 w-2/3 animate-pulse rounded-[2px] bg-admin-border" />
            </div>
          ) : list.data.items.length === 0 ? (
            <p className="p-4 text-xs text-admin-muted">No size guides yet. Create one to show it on product pages.</p>
          ) : (
            <ul className="divide-y divide-admin-border">
              {list.data.items.map((guide) => (
                <li key={guide.id}>
                  <button
                    type="button"
                    onClick={() => setEditing(guide.id)}
                    aria-current={editing === guide.id ? "true" : undefined}
                    className={cn("w-full px-3 py-2.5 text-left transition-colors hover:bg-admin-raised",
                      editing === guide.id && "bg-admin-raised")}
                  >
                    <span className="flex items-center gap-2">
                      <span className="flex-1 truncate text-sm text-admin-ink">{guide.name}</span>
                      {guide.isDefault ? <StatusBadge tone="info">Default</StatusBadge> : null}
                      <StatusBadge tone={guide.status === "active" ? "good" : "neutral"}>{guide.status}</StatusBadge>
                    </span>
                    <span className="mt-0.5 block text-[0.6875rem] text-admin-muted">
                      {KINDS.find((k) => k.value === guide.kind)?.label} · {guide.rows.length} sizes ·{" "}
                      {guide.products} products · {guide.categories} categories
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </AdminCard>

        {editing ? (
          <SizeGuideEditor
            key={editing}
            guideId={editing === "new" ? null : editing}
            templates={list.data?.templates ?? {}}
            onSaved={(id) => {
              setEditing(id);
              void list.reload();
            }}
            onDeleted={() => {
              setEditing(null);
              void list.reload();
            }}
          />
        ) : (
          <AdminCard>
            <p className="text-sm text-admin-muted">Choose a guide to edit it, or create a new one.</p>
          </AdminCard>
        )}
      </div>
    </div>
  );
}

function SizeGuideEditor({
  guideId,
  templates,
  onSaved,
  onDeleted,
}: {
  guideId: string | null;
  templates: Record<string, SizeGuideColumn[]>;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const existing = useAdminResource(() => (guideId ? getSizeGuide(guideId) : Promise.resolve(null)), [guideId]);
  const [draft, setDraft] = useState<SizeGuideInput | null>(guideId ? null : emptyInput(templates));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (existing.data) setDraft(toInput(existing.data));
  }, [existing.data]);

  if (guideId && !draft) {
    return existing.error ? (
      <AdminCard><p role="alert" className="text-sm text-admin-ink">{message(existing.error, "That guide didn't load.")}</p></AdminCard>
    ) : (
      <AdminCard><span aria-busy="true" aria-label="Loading guide" className="block h-40 animate-pulse rounded-[2px] bg-admin-border" /></AdminCard>
    );
  }
  if (!draft) return null;

  const set = <K extends keyof SizeGuideInput>(key: K, value: SizeGuideInput[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const setColumn = (index: number, patch: Partial<SizeGuideColumn>) =>
    set("columns", draft.columns.map((column, i) => {
      if (i !== index) return column;
      const next = { ...column, ...patch };
      // A new column's key follows its name until it's saved.
      if (patch.label !== undefined && !existing.data?.columns.some((c) => c.key === column.key)) next.key = slug(patch.label);
      return next;
    }));

  const removeColumn = (index: number) => {
    const key = draft.columns[index]?.key;
    setDraft({
      ...draft,
      columns: draft.columns.filter((_, i) => i !== index),
      rows: draft.rows.map((row) => ({ ...row, values: Object.fromEntries(Object.entries(row.values)
        .filter(([k]) => k !== key)) })),
      instructions: draft.instructions.map((step) => (step.column === key ? { ...step, column: "" } : step)),
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    // Empty cells are left out, so an optional column can stay blank.
    const payload: SizeGuideInput = {
      ...draft,
      rows: draft.rows.map((row) => ({
        size: row.size,
        values: Object.fromEntries(Object.entries(row.values).filter(([, value]) => value.trim() !== "")),
      })),
    };
    try {
      const saved = guideId ? await updateSizeGuide(guideId, payload) : await createSizeGuide(payload);
      toast.success(guideId ? "Size guide saved." : "Size guide created.");
      onSaved(saved.id);
    } catch (problem) {
      setError(message(problem, "The size guide didn't save."));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!guideId) return;
    setSaving(true);
    try {
      await deleteSizeGuide(guideId);
      toast.success("Size guide deleted.");
      onDeleted();
    } catch (problem) {
      toast.error(message(problem, "The size guide wasn't deleted."));
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <AdminCard title={guideId ? `Edit ${existing.data?.name ?? "size guide"}` : "New size guide"}>
        <div className="flex flex-col gap-4">
          <FormGrid columns={3}>
            <AdminInput label="Name" required value={draft.name} maxLength={120}
              onChange={(event) => set("name", event.target.value)} />
            <AdminSelect
              label="Kind"
              value={draft.kind}
              options={KINDS}
              onChange={(event) => {
                const kind = event.target.value as SizeGuideInput["kind"];
                // A new guide starts from the kind's usual columns; an existing one keeps its own.
                if (!guideId) setDraft({ ...emptyInput(templates, kind), name: draft.name, description: draft.description });
                else set("kind", kind);
              }}
              hint={guideId ? undefined : "Starts the table with this kind's usual columns."}
            />
            <AdminSelect label="Measurements in" value={draft.unit} options={UNITS}
              onChange={(event) => set("unit", event.target.value as SizeGuideInput["unit"])} />
          </FormGrid>
          <AdminTextarea label="Description" rows={2} value={draft.description} maxLength={2000}
            onChange={(event) => set("description", event.target.value)} />
          <div className="flex flex-wrap gap-6">
            <AdminToggle label="Active" description="Inactive guides are shown nowhere."
              checked={draft.status === "active"} onChange={(on) => set("status", on ? "active" : "inactive")} />
            <AdminToggle label="Store default" description="For products with sizes that have no other guide."
              checked={draft.isDefault} onChange={(on) => set("isDefault", on)} />
          </div>
        </div>
      </AdminCard>

      <AdminCard
        title="Table"
        description={`Type a measurement as one number (92) or a range (92-97), in ${draft.unit}. Text columns take anything (UK 7, EU 41).`}
        padded={false}
      >
        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[40rem] text-left text-xs">
            <thead>
              <tr className="border-b border-admin-border align-bottom">
                <th scope="col" className="w-28 py-2 pr-2 font-medium text-admin-muted">Size</th>
                {draft.columns.map((column, index) => (
                  <th key={`${column.key}-${index}`} scope="col" className="py-2 pr-2 font-normal">
                    <div className="flex flex-col gap-1">
                      <input
                        aria-label={`Column ${index + 1} name`}
                        value={column.label}
                        maxLength={40}
                        onChange={(event) => setColumn(index, { label: event.target.value })}
                        className="h-8 w-full rounded-[3px] border border-admin-border px-2 text-xs font-medium text-admin-ink"
                      />
                      <div className="flex items-center gap-1">
                        <select
                          aria-label={`Column ${index + 1} type`}
                          value={column.type}
                          onChange={(event) => setColumn(index, { type: event.target.value as SizeGuideColumn["type"] })}
                          className="h-7 flex-1 rounded-[3px] border border-admin-border text-[0.6875rem]"
                        >
                          <option value="measurement">Measurement</option>
                          <option value="text">Text</option>
                        </select>
                        <button type="button" onClick={() => removeColumn(index)} aria-label={`Remove column ${column.label || index + 1}`}
                          className="rounded-[3px] p-1 text-admin-muted hover:text-[#c23434]">
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      <label className="flex items-center gap-1 text-[0.6875rem] text-admin-muted">
                        <input type="checkbox" checked={column.required !== false}
                          onChange={(event) => setColumn(index, { required: event.target.checked })} />
                        Every size needs one
                      </label>
                    </div>
                  </th>
                ))}
                <th scope="col" className="py-2">
                  <AdminButton size="sm" onClick={() => set("columns", [...draft.columns,
                    { key: `column-${draft.columns.length + 1}`, label: "", type: "measurement", required: true }])}>
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Column
                  </AdminButton>
                </th>
              </tr>
            </thead>
            <tbody>
              {draft.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-admin-border">
                  <td className="py-1.5 pr-2">
                    <input
                      aria-label={`Size ${rowIndex + 1}`}
                      value={row.size}
                      maxLength={30}
                      placeholder="M"
                      onChange={(event) => set("rows", draft.rows.map((r, i) => (i === rowIndex
                        ? { ...r, size: event.target.value } : r)))}
                      className="h-8 w-full rounded-[3px] border border-admin-border px-2 text-xs"
                    />
                  </td>
                  {draft.columns.map((column, index) => (
                    <td key={`${column.key}-${index}`} className="py-1.5 pr-2">
                      <input
                        aria-label={`${row.size || `Size ${rowIndex + 1}`}, ${column.label || `column ${index + 1}`}`}
                        value={row.values[column.key] ?? ""}
                        inputMode={column.type === "measurement" ? "decimal" : "text"}
                        onChange={(event) => set("rows", draft.rows.map((r, i) => (i === rowIndex
                          ? { ...r, values: { ...r.values, [column.key]: event.target.value } } : r)))}
                        className="h-8 w-full rounded-[3px] border border-admin-border px-2 text-xs tabular-nums"
                      />
                    </td>
                  ))}
                  <td className="py-1.5">
                    <button type="button" aria-label={`Remove size ${row.size || rowIndex + 1}`}
                      onClick={() => set("rows", draft.rows.filter((_, i) => i !== rowIndex))}
                      className="rounded-[3px] p-1 text-admin-muted hover:text-[#c23434]">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AdminButton size="sm" className="mt-3" onClick={() => set("rows", [...draft.rows, { size: "", values: {} }])}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Size
          </AdminButton>
        </div>
      </AdminCard>

      <AdminCard title="How to measure" description="Shown under the table. Point a step at a column to explain it.">
        <div className="flex flex-col gap-3">
          {draft.instructions.map((step, index) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[12rem_10rem_1fr_auto] sm:items-end">
              <AdminInput label="Title" value={step.title} maxLength={80}
                onChange={(event) => set("instructions", draft.instructions.map((s, i) => (i === index
                  ? { ...s, title: event.target.value } : s)))} />
              <AdminSelect label="Column" value={step.column}
                options={[{ value: "", label: "General" }, ...draft.columns.map((c) => ({ value: c.key, label: c.label || c.key }))]}
                onChange={(event) => set("instructions", draft.instructions.map((s, i) => (i === index
                  ? { ...s, column: event.target.value } : s)))} />
              <AdminInput label="How" value={step.body} maxLength={1000}
                onChange={(event) => set("instructions", draft.instructions.map((s, i) => (i === index
                  ? { ...s, body: event.target.value } : s)))} />
              <AdminButton size="sm" variant="ghost" aria-label={`Remove step ${step.title || index + 1}`}
                onClick={() => set("instructions", draft.instructions.filter((_, i) => i !== index))}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </AdminButton>
            </div>
          ))}
          <div>
            <AdminButton size="sm" onClick={() => set("instructions", [...draft.instructions, { title: "", body: "", column: "" }])}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Step
            </AdminButton>
          </div>
          <AdminTextarea label="Notes" rows={2} value={draft.notes} maxLength={2000}
            onChange={(event) => set("notes", event.target.value)} hint="e.g. “Between sizes? Size up.”" />
        </div>
      </AdminCard>

      {error ? (
        <p role="alert" className="rounded-[3px] border border-[#c23434]/30 bg-[#fbeaea] px-3 py-2 text-sm text-[#a32c2c]">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {guideId ? (
          <AdminButton variant="danger" onClick={() => setConfirming(true)} disabled={saving}>Delete</AdminButton>
        ) : null}
        <AdminButton variant="primary" loading={saving} onClick={() => void save()}>
          {guideId ? "Save size guide" : "Create size guide"}
        </AdminButton>
      </div>

      {guideId && existing.data ? <Assignments guide={existing.data} onChanged={() => void existing.reload()} /> : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete this size guide?"
        message={`It is assigned to ${existing.data?.products ?? 0} product(s) and ${existing.data?.categories ?? 0} categor${(existing.data?.categories ?? 0) === 1 ? "y" : "ies"}. They will fall back to their category's guide or the store default. To hide it without losing it, switch it off instead.`}
        loading={saving}
        onConfirm={() => void remove()}
      />
    </div>
  );
}

function Assignments({ guide, onChanged }: { guide: AdminSizeGuide; onChanged: () => void }) {
  const [chosen, setChosen] = useState<string[]>(guide.categoryIds);
  const [savingCategories, setSavingCategories] = useState(false);

  useEffect(() => setChosen(guide.categoryIds), [guide.categoryIds]);

  const assigned = new Set((guide.assignedProducts ?? []).map((p) => p.id));

  const saveCategories = async () => {
    setSavingCategories(true);
    try {
      const result = await setSizeGuideCategories(guide.id, chosen);
      toast.success(result.movedFromOtherGuides
        ? `Categories saved — ${result.movedFromOtherGuides} moved from another guide.` : "Categories saved.");
      onChanged();
    } catch (error) {
      toast.error(message(error, "The categories didn't save."));
    } finally {
      setSavingCategories(false);
    }
  };

  const products = async (ids: string[], mode: "add" | "remove") => {
    try {
      await setSizeGuideProducts(guide.id, ids, mode);
      toast.success(mode === "add" ? "Product assigned." : "Product removed.");
      onChanged();
    } catch (error) {
      toast.error(message(error, "That didn't save."));
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <AdminCard title="Categories" description="The guide every product with sizes in these categories shows, unless it has its own.">
        <div className="flex flex-col">
          {/* Categories are chosen by Category ID (docs/id-lookup.md). */}
          <IdMultiSelect
            entity="category"
            label="Add a category — Category ID"
            placeholder="Search Category ID…"
            values={chosen}
            onChange={setChosen}
            emptyText="No categories yet. Add them by Category ID."
          />
          <div className="mt-3">
            <AdminButton size="sm" loading={savingCategories} onClick={() => void saveCategories()}>Save categories</AdminButton>
          </div>
        </div>
      </AdminCard>

      <AdminCard title="Products" description="Products that show this guide whatever their category's is.">
        <IdAutocomplete
          entity="product"
          label="Assign a product — Product ID or SKU"
          placeholder="Search Product ID or SKU…"
          exclude={[...assigned]}
          onSelect={(id) => void products([id], "add")}
        />
        <ul className="mt-3 flex flex-col gap-1">
          {(guide.assignedProducts ?? []).length === 0 ? (
            <li className="text-xs text-admin-muted">None assigned directly.</li>
          ) : (guide.assignedProducts ?? []).map((product) => (
            <li key={product.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1 truncate text-admin-ink">{product.name}</span>
              <span className="text-admin-muted">{product.status}</span>
              <button type="button" onClick={() => void products([product.id], "remove")}
                aria-label={`Unassign ${product.name}`} className="p-1 text-admin-muted hover:text-[#c23434]">
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </AdminCard>
    </div>
  );
}
