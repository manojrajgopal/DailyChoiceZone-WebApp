"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";

import type { PurchaseOrder, SupplierProduct } from "@/types/suppliers";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect, AdminTextarea, FormGrid, FormSection } from "@/components/admin/ui/AdminForm";
import { ProductPicker } from "@/components/admin/views/growth/shared";
import { IdSelector } from "@/components/common/IdSelector";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { createPurchaseOrder, updatePurchaseOrder } from "@/services/purchaseOrdersService";
import { getSupplier, listSupplierProducts } from "@/services/suppliersService";
import { toast } from "@/store/toastStore";

import { ADMIN_CRUMB, NoAccess, PURCHASE_ORDERS_CRUMB, isForbidden, problem, rupees, serverFieldErrors } from "./shared";
import {
  type Errors,
  type PoDraft,
  type PoLineDraft,
  previewSubtotal,
  toPurchaseOrderInput,
  validatePurchaseOrder,
} from "./validation";

const ERROR_FIELDS = {
  SUPPLIER_INACTIVE: "supplierId",
  SUPPLIER_NOT_FOUND: "supplierId",
  NO_ITEMS: "items",
  DUPLICATE_ITEM: "items",
  UNIT_COST_REQUIRED: "items",
  PRODUCT_ARCHIVED: "items",
  PRODUCT_NOT_FOUND: "items",
};

/** A server warning as text, whether it arrives as a string or as `{ message }`. */
export function warningText(warning: unknown): string {
  if (typeof warning === "string") return warning;
  if (warning && typeof warning === "object" && typeof (warning as { message?: unknown }).message === "string") {
    return (warning as { message: string }).message;
  }
  return String(warning);
}

export function PoWarnings({ warnings }: { warnings: unknown[] | undefined }) {
  if (!warnings?.length) return null;
  return (
    <div role="status" className="mb-4 rounded-[3px] border border-[#f2d9a8] bg-[#fdf3e3] px-3 py-2.5 text-xs text-[#8a5a12]">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        Saved, with {warnings.length === 1 ? "a warning" : `${warnings.length} warnings`}
      </p>
      <ul className="mt-1 list-disc pl-5">
        {warnings.map((warning, index) => (
          <li key={index}>{warningText(warning)}</li>
        ))}
      </ul>
    </div>
  );
}

/** `/admin/purchase-orders/new?supplier=SUP001` — the supplier is optional. */
export function AdminNewPurchaseOrderView() {
  const params = useSearchParams();
  const supplier = params?.get("supplier") ?? "";
  return <PurchaseOrderForm key={supplier} initialSupplierId={supplier} />;
}

function linesFromPo(po: PurchaseOrder): PoLineDraft[] {
  return po.items.map((item) => ({
    productId: item.productId,
    name: item.name,
    sku: item.sku,
    supplierSku: item.supplierSku,
    quantity: String(item.quantity),
    unitCost: String(item.unitCost),
    taxRate: String(item.taxRate),
    moq: null,
  }));
}

/**
 * Raise a draft purchase order, or change one (`po` given — drafts only).
 * The subtotal shown while typing is a preview; tax and the totals that count
 * come back from the server.
 */
export function PurchaseOrderForm({
  po,
  initialSupplierId = "",
  onSaved,
  onCancel,
}: {
  po?: PurchaseOrder;
  initialSupplierId?: string;
  /** Edit mode: called with the saved PO instead of navigating. */
  onSaved?: (po: PurchaseOrder) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const editing = Boolean(po);
  const [draft, setDraft] = useState<PoDraft>(() => ({
    supplierId: po?.supplier.id ?? initialSupplierId,
    lines: po ? linesFromPo(po) : [],
    expectedAt: po?.expectedAt?.slice(0, 10) ?? "",
    supplierReference: po?.supplierReference ?? "",
    notes: po?.notes ?? "",
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<PurchaseOrder | null>(null);

  // The supplier is chosen by its Supplier ID (docs/id-lookup.md); only that
  // one supplier is read — for its status and billing state — never a list.
  const supplierInfo = useAdminResource(() => getSupplier(draft.supplierId), [draft.supplierId], {
    enabled: Boolean(draft.supplierId),
  });
  const links = useAdminResource(() => listSupplierProducts(draft.supplierId), [draft.supplierId], {
    enabled: Boolean(draft.supplierId),
  });
  const linkList: SupplierProduct[] = draft.supplierId ? (links.data ?? []) : [];
  const linkFor = (productId: string) => linkList.find((link) => link.productId === productId);

  const selected = draft.supplierId && supplierInfo.data?.id === draft.supplierId ? supplierInfo.data : null;
  const supplierInfoError = draft.supplierId ? supplierInfo.error : null;
  const supplierName = selected?.name ?? (po && po.supplier.id === draft.supplierId ? po.supplier.name : "");
  const inactive = selected && selected.status !== "active";
  const supplierError =
    errors.supplierId ?? (inactive ? "This supplier isn't active. Activate it before raising a purchase order." : undefined);

  const clear = (...keys: string[]) =>
    setErrors((current) => {
      if (!keys.some((key) => current[key])) return current;
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });

  const addLine = (product: { id: string; name: string; sku: string }) => {
    if (draft.lines.some((line) => line.productId === product.id)) {
      setErrors((current) => ({ ...current, items: `${product.name} is already on this order.` }));
      return;
    }
    const link = linkFor(product.id);
    setDraft((current) => ({
      ...current,
      lines: [
        ...current.lines,
        {
          productId: product.id,
          name: product.name,
          sku: product.sku,
          supplierSku: link?.supplierSku ?? "",
          quantity: link ? String(Math.max(1, link.moq)) : "1",
          unitCost: link ? String(link.purchaseCost) : "",
          taxRate: "",
          moq: link?.moq ?? null,
        },
      ],
    }));
    clear("items");
  };

  const updateLine = (index: number, patch: Partial<PoLineDraft>) => {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line, at) => (at === index ? { ...line, ...patch } : line)),
    }));
    clear(...Object.keys(patch).map((key) => `items.${index}.${key}`), "items");
  };

  const removeLine = (index: number) => {
    setDraft((current) => ({ ...current, lines: current.lines.filter((_, at) => at !== index) }));
    // Line errors are keyed by position, which just changed.
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith("items."))));
  };

  const save = async () => {
    const withLinks: PoDraft = {
      ...draft,
      lines: draft.lines.map((line) => ({ ...line, moq: linkFor(line.productId)?.moq ?? null })),
    };
    const found = validatePurchaseOrder(withLinks);
    if (inactive) found.supplierId = "This supplier isn't active. Activate it before raising a purchase order.";
    setFormError("");
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSaving(true);
    try {
      const input = toPurchaseOrderInput(withLinks);
      const saved = po ? await updatePurchaseOrder(po.id, input) : await createPurchaseOrder(input);
      toast.success(po ? "Purchase order updated" : `${saved.poNumber} saved as a draft`);
      if (onSaved) onSaved(saved);
      else if (saved.warnings?.length) setCreated(saved);
      else router.push(`/admin/purchase-orders/detail?id=${encodeURIComponent(saved.id)}`);
    } catch (error) {
      const fields = serverFieldErrors(error, ERROR_FIELDS);
      setErrors(fields);
      const message = problem(error, "The purchase order wasn't saved. Please try again.");
      if (Object.keys(fields).length === 0) setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const crumbs = [ADMIN_CRUMB, PURCHASE_ORDERS_CRUMB, { label: "New" }];

  if (created) {
    return (
      <div>
        <AdminPageHeader title={`${created.poNumber} saved`} breadcrumbs={crumbs} />
        <PoWarnings warnings={created.warnings} />
        <AdminButtonLink href={`/admin/purchase-orders/detail?id=${encodeURIComponent(created.id)}`} variant="primary">
          Open {created.poNumber}
        </AdminButtonLink>
      </div>
    );
  }

  if (!editing && isForbidden(supplierInfoError)) {
    return (
      <div>
        <AdminPageHeader title="New purchase order" breadcrumbs={crumbs} />
        <NoAccess area="suppliers" />
      </div>
    );
  }

  const subtotal = previewSubtotal(draft.lines);
  const activeLinks = linkList.filter((link) => link.status === "active");

  const body = (
    <form
      noValidate
      aria-label={editing ? `Edit ${po?.poNumber}` : "New purchase order"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4"
    >
      {formError ? (
        <p role="alert" className="rounded-[3px] border border-[#f1c4c4] bg-[#fbeaea] px-3 py-2 text-xs text-[#a12b2b]">
          {formError}
        </p>
      ) : null}

      <FormSection title="Supplier">
        <div className="mb-3 flex max-w-xl flex-col gap-1">
          <IdSelector
            entity="supplier"
            required
            value={draft.supplierId}
            onChange={(supplierId) => {
              setDraft((current) => ({ ...current, supplierId: supplierId ?? "" }));
              clear("supplierId");
            }}
          />
          {supplierError ? (
            <p role="alert" className="text-[0.6875rem] text-[#c23434]">
              {supplierError}
            </p>
          ) : selected?.billingAddress?.state ? (
            <p className="text-[0.6875rem] text-admin-muted">Billing state: {selected.billingAddress.state}</p>
          ) : null}
        </div>
        <FormGrid>
          <AdminInput
            label="Expected delivery"
            type="date"
            value={draft.expectedAt}
            onChange={(event) => setDraft((current) => ({ ...current, expectedAt: event.target.value }))}
            error={errors.expectedAt}
          />
          <AdminInput
            label="Supplier reference"
            value={draft.supplierReference}
            onChange={(event) => setDraft((current) => ({ ...current, supplierReference: event.target.value }))}
            hint="Their quotation or order number, if any."
            error={errors.supplierReference}
          />
        </FormGrid>
        {supplierInfoError && !isForbidden(supplierInfoError) ? (
          <p className="mt-2 text-xs text-[#a32424]">
            The supplier&rsquo;s details didn&rsquo;t load.{" "}
            <button type="button" className="underline" onClick={() => void supplierInfo.reload()}>
              Try again
            </button>
          </p>
        ) : null}
      </FormSection>

      <FormSection title="Items" description="Unit costs are before GST. A linked product's cost is filled in from the supplier.">
        {draft.supplierId && activeLinks.length > 0 ? (
          <AdminSelect
            label={`Add from ${supplierName || "this supplier"}'s products`}
            value=""
            placeholder="Choose a linked product"
            options={activeLinks.map((link) => ({
              value: link.productId,
              label: `${link.productId} · ${link.productName} · ${link.productSku} · ${rupees(link.purchaseCost)}`,
            }))}
            onChange={(event) => {
              const link = activeLinks.find((entry) => entry.productId === event.target.value);
              if (link) addLine({ id: link.productId, name: link.productName, sku: link.productSku });
            }}
            className="mb-3"
          />
        ) : null}
        <ProductPicker label="Add any product" chosen={draft.lines.map((line) => line.productId)} onPick={(product) => addLine(product)} />

        {errors.items ? (
          <p role="alert" className="mt-2 text-[0.6875rem] text-[#c23434]">
            {errors.items}
          </p>
        ) : null}

        {draft.lines.length === 0 ? (
          <p className="mt-4 rounded-[3px] bg-admin-raised px-3 py-6 text-center text-xs text-admin-muted">
            No products yet. {draft.supplierId ? "Add one from the supplier's products or search above." : "Choose a supplier, then add products."}
          </p>
        ) : (
          <ul className="mt-4 flex flex-col divide-y divide-admin-border" aria-label="Order lines">
            {draft.lines.map((line, index) => {
              const link = linkFor(line.productId);
              const quantity = Number(line.quantity);
              const below = link && Number.isFinite(quantity) && quantity > 0 && quantity < link.moq;
              const lineSubtotal = Number(line.quantity) * Number(line.unitCost);
              return (
                <li key={line.productId} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_6rem_8rem_6rem_7rem_auto] sm:items-start">
                  <div className="min-w-0 text-xs">
                    <span className="block truncate font-medium text-admin-ink">{line.name}</span>
                    <span className="block text-admin-muted">
                      {line.sku}
                      {link?.supplierSku || line.supplierSku ? ` · Supplier SKU ${link?.supplierSku || line.supplierSku}` : ""}
                    </span>
                    {link ? null : draft.supplierId && links.data ? (
                      <span className="block text-[0.6875rem] text-[#8a5a12]">Not linked to this supplier — enter the cost.</span>
                    ) : null}
                  </div>
                  <AdminInput
                    label={`Quantity of ${line.name}`}
                    inputMode="numeric"
                    value={line.quantity}
                    onChange={(event) => updateLine(index, { quantity: event.target.value })}
                    error={errors[`items.${index}.quantity`]}
                    hint={below ? `Below the minimum order of ${link.moq}.` : link ? `MOQ ${link.moq}` : undefined}
                  />
                  <AdminInput
                    label={`Unit cost of ${line.name}`}
                    prefix="₹"
                    inputMode="decimal"
                    value={line.unitCost}
                    onChange={(event) => updateLine(index, { unitCost: event.target.value })}
                    error={errors[`items.${index}.unitCost`]}
                  />
                  <AdminInput
                    label={`Tax rate of ${line.name}`}
                    inputMode="decimal"
                    value={line.taxRate}
                    placeholder="Default"
                    onChange={(event) => updateLine(index, { taxRate: event.target.value })}
                    error={errors[`items.${index}.taxRate`]}
                    hint="%"
                  />
                  <div className="text-xs sm:pt-6 sm:text-right">
                    <span className="sr-only">Line subtotal: </span>
                    <span className="tabular-nums text-admin-ink" data-line-subtotal={line.productId}>
                      {Number.isFinite(lineSubtotal) && lineSubtotal > 0 ? rupees(Math.round(lineSubtotal * 100) / 100) : "—"}
                    </span>
                  </div>
                  <AdminButton size="sm" variant="ghost" className="sm:mt-5" onClick={() => removeLine(index)} aria-label={`Remove ${line.name}`}>
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  </AdminButton>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-admin-border pt-3 text-xs">
          <span className="text-admin-muted">GST and the final total are worked out when you save.</span>
          <span className="text-admin-ink">
            Subtotal before tax: <strong className="tabular-nums" aria-live="polite">{rupees(subtotal)}</strong>
          </span>
        </div>
      </FormSection>

      <FormSection title="Notes">
        <AdminTextarea
          label="Notes for this order"
          rows={3}
          value={draft.notes}
          onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
        />
      </FormSection>

      <div className={cn("flex flex-wrap items-center justify-end gap-2", !editing && "pb-4")}>
        {onCancel ? (
          <AdminButton variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </AdminButton>
        ) : (
          <AdminButtonLink href="/admin/purchase-orders" variant="ghost">
            Cancel
          </AdminButtonLink>
        )}
        <AdminButton type="submit" variant="primary" loading={saving}>
          {editing ? "Save changes" : "Save as draft"}
        </AdminButton>
      </div>
    </form>
  );

  if (editing) return <AdminCard title={`Edit ${po?.poNumber}`} description="Only a draft can be changed.">{body}</AdminCard>;

  return (
    <div className="max-w-5xl">
      <AdminPageHeader
        title="New purchase order"
        description="Saved as a draft. Submit and send it from the order page when it's ready."
        breadcrumbs={crumbs}
        actions={
          draft.supplierId ? (
            <Link href={`/admin/suppliers/detail?id=${encodeURIComponent(draft.supplierId)}`} className="text-xs text-admin-muted hover:text-admin-ink">
              View supplier
            </Link>
          ) : undefined
        }
      />
      {body}
    </div>
  );
}
