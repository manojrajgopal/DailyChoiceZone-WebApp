/**
 * The ID lookup API (docs/id-lookup.md) as tests fake it.
 *
 *   lookupBackend("product", [productPreview(), productPreview({ id: "PRD002", name: "Linen Shirt" })]);
 *
 * registers both requests an ID field makes: the suggestions
 * (`GET /admin/lookup/product?q=`, IDs only, matched by prefix on the ID or
 * the SKU — never the name) and the exact preview
 * (`GET /admin/lookup/product/PRD001`, 404 for anything else).
 */
import type { LookupEntity, LookupScope } from "@/lib/lookup/entities";
import type { IdPreview } from "@/services/lookupService";

import { api, fail } from "./api";

type Field = IdPreview["fields"][number];

export function idPreview(
  entity: LookupEntity,
  id: string,
  overrides: Partial<IdPreview> & { label?: string } = {},
): IdPreview {
  const label = overrides.label ?? entity.charAt(0).toUpperCase() + entity.slice(1).replace(/_/g, " ");
  return {
    entity,
    label,
    idLabel: `${label} ID`,
    example: id,
    volatile: true,
    id,
    key: id,
    title: id,
    subtitle: "",
    status: "",
    image: null,
    fields: [],
    related: [],
    ...overrides,
  } as IdPreview;
}

/** A product's preview, from rupees as the pickers use them (the API sends paise). */
export function productPreview(
  overrides: Partial<{ id: string; name: string; sku: string; price: number; stock: number; available: number; status: string }> = {},
): IdPreview {
  const p = { id: "PRD001", name: "Cotton Kurta", sku: "DCZ-WO0001", price: 499, stock: 25, status: "active", ...overrides };
  const fields: Field[] = [
    { label: "SKU", value: p.sku, format: "text" },
    { label: "Price", value: Math.round(p.price * 100), format: "money" },
    { label: "Stock", value: p.stock, format: "number" },
    { label: "Available", value: p.available ?? p.stock, format: "number" },
  ];
  return idPreview("product", p.id, { title: p.name, status: p.status, fields });
}

export function supplierPreview(overrides: Partial<{ id: string; name: string; code: string; status: string }> = {}): IdPreview {
  const s = { id: "SUP001", name: "Anvi Textiles", code: "ANVI-TEX", status: "active", ...overrides };
  return idPreview("supplier", s.id, {
    title: s.name,
    subtitle: s.code,
    status: s.status,
    volatile: false,
    fields: [{ label: "Code", value: s.code, format: "text" }],
  });
}

/** The other identifier a preview carries (a product's SKU, a supplier's code), for matching. */
function secondaryIds(preview: IdPreview): string[] {
  return preview.fields
    .filter((field) => field.label === "SKU" || field.label === "Code")
    .map((field) => String(field.value).toUpperCase());
}

export function lookupBackend(entity: LookupEntity, previews: IdPreview[], scope: LookupScope = "admin") {
  const base = `/${scope}/lookup/${entity}`;
  api.get(base, (request) => {
    const q = (request.query.get("q") ?? "").toUpperCase().replace(/\s+/g, "");
    const items = q
      ? previews.flatMap((preview) => {
          if (preview.id.toUpperCase().startsWith(q)) return [{ id: preview.id }];
          const other = secondaryIds(preview).find((value) => value.startsWith(q));
          return other ? [{ id: preview.id, match: other }] : [];
        })
      : [];
    return { entity, query: q, items, hasMore: false };
  });
  api.get(new RegExp(`^${base}/([^/]+)$`), (request) => {
    const id = decodeURIComponent(request.path.split("/").pop() ?? "").toUpperCase();
    const preview = previews.find((p) => p.id.toUpperCase() === id || secondaryIds(p).includes(id));
    return preview ?? fail(404, `ID ${id} was not found.`, "LOOKUP_NOT_FOUND");
  });
}
