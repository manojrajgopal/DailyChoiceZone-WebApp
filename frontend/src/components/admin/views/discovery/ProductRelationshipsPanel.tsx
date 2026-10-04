"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { IdAutocomplete } from "@/components/common/IdAutocomplete";
import { AdminCheckbox, AdminToggle, FormSection } from "@/components/admin/ui/AdminForm";
import { DomainStatus, StatusBadge } from "@/components/admin/ui/StatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import {
  RELATIONSHIP_TYPES,
  addRelationships,
  deleteRelationship,
  listRelationships,
  previewRecommendations,
  reorderRelationships,
  updateRelationship,
  type PreviewEntry,
  type Relationship,
} from "@/services/admin/discoveryAdminService";
import type { RecommendationType } from "@/services/discoveryService";
import { toast } from "@/store/toastStore";

const SOURCE_LABELS: Record<PreviewEntry["source"], string> = {
  manual: "Chosen",
  score: "Automatic",
  copurchase: "Bought together",
  "fallback-category": "Category best",
  "fallback-best-sellers": "Best seller",
};

function message(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/**
 * Related products, on the product edit page.
 *
 * The store's own choices, per type, in the order the storefront shows them —
 * ahead of anything worked out automatically. The preview shows the rail
 * exactly as a shopper will get it, with where each product came from.
 */
export function ProductRelationshipsPanel({ productId }: { productId: string }) {
  const [type, setType] = useState<RecommendationType>("related");
  const relationships = useAdminResource(() => listRelationships(productId), [productId], {
    enabled: Boolean(productId),
  });
  const [rows, setRows] = useState<Relationship[] | null>(null);
  useEffect(() => {
    if (relationships.data) setRows(relationships.data);
  }, [relationships.data]);
  const all = rows ?? relationships.data ?? [];
  const ofType = all.filter((row) => row.type === type).sort((a, b) => a.position - b.position);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<Relationship[]>, done?: string) => {
    setBusy(true);
    try {
      setRows(await work());
      if (done) toast.success(done);
    } catch (error) {
      toast.error(message(error, "That didn't save. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, by: -1 | 1) => {
    const ids = ofType.map((row) => row.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void run(() => reorderRelationships(productId, type, ids));
  };

  const forbidden = relationships.error instanceof ApiError && relationships.error.status === 403;

  return (
    <FormSection
      title="Related products"
      description="Shown on this product's page ahead of anything chosen automatically. Drafts and archived products are never shown to shoppers."
    >
      {forbidden ? (
        <p className="text-xs text-admin-muted">Your role doesn&rsquo;t include products.</p>
      ) : relationships.error && !relationships.data ? (
        <div role="alert" className="text-xs text-admin-ink">
          The relationships didn&rsquo;t load.
          <AdminButton size="sm" className="ml-2" onClick={() => void relationships.reload()}>Try again</AdminButton>
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Relationship type" className="mb-4 flex flex-wrap gap-1.5">
            {RELATIONSHIP_TYPES.map((option) => {
              const count = all.filter((row) => row.type === option.value).length;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="tab"
                  aria-selected={type === option.value}
                  onClick={() => setType(option.value)}
                  title={option.hint}
                  className={cn(
                    "rounded-[3px] border px-2.5 py-1 text-xs transition-colors",
                    type === option.value
                      ? "border-admin-ink bg-admin-ink text-white"
                      : "border-admin-border text-admin-ink hover:border-admin-ink",
                  )}
                >
                  {option.label}
                  {count ? <span className="ml-1 tabular-nums opacity-70">{count}</span> : null}
                </button>
              );
            })}
          </div>

          {!relationships.data && !rows ? (
            <div aria-busy="true" aria-label="Loading relationships" className="flex flex-col gap-2">
              <span className="block h-4 w-full animate-pulse rounded-[2px] bg-admin-border" />
              <span className="block h-4 w-2/3 animate-pulse rounded-[2px] bg-admin-border" />
            </div>
          ) : ofType.length === 0 ? (
            <p className="rounded-[3px] bg-admin-raised px-3 py-4 text-xs text-admin-muted">
              None chosen. The storefront works this list out from the category, brand, tags, price and what is
              bought together — add products below to put them first.
            </p>
          ) : (
            <ol className="divide-y divide-admin-border rounded-[3px] border border-admin-border" aria-label="Chosen products, in order">
              {ofType.map((row, index) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="w-5 text-right text-xs tabular-nums text-admin-muted">{index + 1}</span>
                  {row.related?.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={row.related.image} alt="" className="h-10 w-8 rounded-[2px] object-cover" />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-admin-ink">{row.related?.name ?? row.relatedProductId}</p>
                    <p className="text-[0.6875rem] text-admin-muted">
                      {row.related?.sku} · {row.related ? formatPrice(row.related.price) : ""} · {row.related?.stock ?? 0} in stock
                    </p>
                  </div>
                  {row.related ? <DomainStatus domain="product" status={row.related.status} /> : null}
                  <AdminToggle
                    label="Shown"
                    checked={row.active}
                    disabled={busy}
                    onChange={(active) => void run(() => updateRelationship(productId, row.id, { active }))}
                  />
                  <div className="flex items-center gap-0.5">
                    <AdminButton size="sm" variant="ghost" aria-label={`Move ${row.related?.name ?? ""} up`}
                      disabled={busy || index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                    </AdminButton>
                    <AdminButton size="sm" variant="ghost" aria-label={`Move ${row.related?.name ?? ""} down`}
                      disabled={busy || index === ofType.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                    </AdminButton>
                    <AdminButton size="sm" variant="ghost" aria-label={`Remove ${row.related?.name ?? ""}`}
                      disabled={busy} onClick={() => void run(() => deleteRelationship(productId, row.id), "Removed.")}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </AdminButton>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <ProductPicker
            productId={productId}
            exclude={new Set([productId, ...ofType.map((row) => row.relatedProductId)])}
            busy={busy}
            onAdd={(ids, reciprocal) =>
              run(() => addRelationships(productId, { relatedProductIds: ids, type, reciprocal }), "Added.")
            }
          />

          <Preview productId={productId} type={type} version={all.length + all.filter((r) => r.active).length} />
        </>
      )}
    </FormSection>
  );
}

/** Related products are added by Product ID or SKU — never by name (docs/id-lookup.md). */
function ProductPicker({
  productId,
  exclude,
  busy,
  onAdd,
}: {
  productId: string;
  exclude: Set<string>;
  busy: boolean;
  onAdd: (ids: string[], reciprocal: boolean) => Promise<void>;
}) {
  const [reciprocal, setReciprocal] = useState(false);

  return (
    <div className="mt-5">
      <IdAutocomplete
        entity="product"
        label="Add products — Product ID or SKU"
        placeholder="Search Product ID or SKU…"
        exclude={[productId, ...exclude]}
        disabled={busy}
        onSelect={(id) => void onAdd([id], reciprocal)}
      />
      <AdminCheckbox
        label="Also show this product on theirs"
        description="Adds the reverse relationship where it is missing."
        checked={reciprocal}
        onChange={(event) => setReciprocal(event.target.checked)}
        className="mt-2"
      />
    </div>
  );
}

function Preview({ productId, type, version }: { productId: string; type: RecommendationType; version: number }) {
  const [open, setOpen] = useState(false);
  const preview = useAdminResource(() => previewRecommendations(productId, type), [productId, type, version], {
    enabled: open,
  });

  return (
    <div className="mt-6 border-t border-admin-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-admin-ink">Storefront preview</p>
          <p className="text-[0.6875rem] text-admin-muted">The rail as shoppers see it now, with where each product came from.</p>
        </div>
        <AdminButton size="sm" onClick={() => (open ? void preview.reload() : setOpen(true))}>
          {open ? "Refresh" : "Preview"}
        </AdminButton>
      </div>
      {open ? (
        preview.isLoading ? (
          <p className="mt-3 text-xs text-admin-muted">Loading…</p>
        ) : preview.error ? (
          <p role="alert" className="mt-3 text-xs text-admin-ink">{message(preview.error, "The preview didn't load.")}</p>
        ) : (preview.data?.items.length ?? 0) === 0 ? (
          <p className="mt-3 text-xs text-admin-muted">Nothing would be shown — the storefront hides this rail.</p>
        ) : (
          <ol className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {preview.data!.items.map((entry) => (
              <li key={entry.product.id} className="rounded-[3px] border border-admin-border p-2">
                {entry.product.images[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={entry.product.images[0]} alt="" className="aspect-[3/4] w-full rounded-[2px] object-cover" />
                ) : null}
                <p className="mt-1.5 line-clamp-2 text-xs text-admin-ink">{entry.product.name}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <StatusBadge tone={entry.source === "manual" ? "info" : "neutral"}>{SOURCE_LABELS[entry.source]}</StatusBadge>
                  {!entry.inStock ? <StatusBadge tone="warning">Out of stock</StatusBadge> : null}
                </div>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </div>
  );
}
