"use client";

import { useState } from "react";
import { X } from "lucide-react";

import type { SupplierProduct, SupplierProductStatus } from "@/types/suppliers";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminTextarea, FormGrid } from "@/components/admin/ui/AdminForm";
import { ProductPicker } from "@/components/admin/views/growth/shared";
import { Modal } from "@/components/ui/Dialog";
import { addSupplierProduct, updateSupplierProduct } from "@/services/suppliersService";
import { toast } from "@/store/toastStore";

import { problem, serverFieldErrors } from "./shared";
import { type Errors, type SupplierProductDraft, toSupplierProductInput, validateSupplierProduct } from "./validation";

/**
 * Link a product to a supplier, or change a link: the supplier's SKU, what it
 * costs to buy, the minimum order and the lead time. Render it only while
 * open, so each opening starts fresh.
 */
export function SupplierProductDialog({
  supplierId,
  supplierName,
  link,
  linkedProductIds,
  onClose,
  onSaved,
}: {
  supplierId: string;
  supplierName: string;
  /** The link being edited; omitted to add one. */
  link?: SupplierProduct;
  /** Products already linked to this supplier, which can't be added again. */
  linkedProductIds: string[];
  onClose: () => void;
  onSaved: (link: SupplierProduct) => void;
}) {
  const [product, setProduct] = useState<{ id: string; name: string; sku: string } | null>(
    link ? { id: link.productId, name: link.productName, sku: link.productSku } : null,
  );
  const [draft, setDraft] = useState<SupplierProductDraft>(() => ({
    supplierSku: link?.supplierSku ?? "",
    purchaseCost: link ? String(link.purchaseCost) : "",
    moq: link ? String(link.moq) : "1",
    leadTimeDays: link?.leadTimeDays === null || link?.leadTimeDays === undefined ? "" : String(link.leadTimeDays),
    status: link?.status ?? "active",
    preferred: link?.preferred ?? false,
    notes: link?.notes ?? "",
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof SupplierProductDraft>(key: K, value: SupplierProductDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key as string]) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  };

  const save = async () => {
    const found = validateSupplierProduct(draft);
    if (!product) found.productId = "Choose a product.";
    setFormError("");
    setErrors(found);
    if (Object.keys(found).length > 0 || !product) return;

    setSaving(true);
    try {
      const input = toSupplierProductInput(draft);
      const saved = link
        ? await updateSupplierProduct(link.id, input)
        : await addSupplierProduct(supplierId, { productId: product.id, ...input });
      toast.success(link ? "Supplier product updated" : `${product.name} linked to ${supplierName}`);
      onSaved(saved);
    } catch (error) {
      const fields = serverFieldErrors(error, {
        SUPPLIER_PRODUCT_EXISTS: "productId",
        PRODUCT_NOT_FOUND: "productId",
        PRODUCT_ARCHIVED: "productId",
      });
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(problem(error, "The link wasn't saved. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !saving && onClose()}
      title={link ? `Edit ${link.productName}` : `Link a product to ${supplierName}`}
      className="max-w-xl"
    >
      <form
        noValidate
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

        {link ? null : (
          <div>
            <p className="mb-1.5 text-xs font-medium text-admin-ink">
              Product<span className="ml-0.5 text-[#c23434]" aria-hidden="true">*</span>
            </p>
            {product ? (
              <div className="flex items-center justify-between gap-3 rounded-[3px] border border-admin-border px-3 py-2 text-xs">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-admin-ink">{product.name}</span>
                  <span className="text-admin-muted">{product.sku}</span>
                </span>
                <AdminButton size="sm" variant="ghost" onClick={() => setProduct(null)} aria-label={`Choose a different product than ${product.name}`}>
                  <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Change
                </AdminButton>
              </div>
            ) : (
              <ProductPicker
                label="Find a product"
                chosen={linkedProductIds}
                onPick={(picked) => {
                  setProduct({ id: picked.id, name: picked.name, sku: picked.sku });
                  setErrors((current) => {
                    const next = { ...current };
                    delete next.productId;
                    return next;
                  });
                }}
              />
            )}
            {errors.productId ? (
              <p role="alert" className="mt-1.5 text-[0.6875rem] text-[#c23434]">
                {errors.productId}
              </p>
            ) : null}
          </div>
        )}

        <FormGrid>
          <AdminInput label="Supplier's SKU" value={draft.supplierSku} onChange={(e) => set("supplierSku", e.target.value)} hint="Their code for it, printed on purchase orders." />
          <AdminInput
            label="Purchase cost"
            required
            prefix="₹"
            inputMode="decimal"
            value={draft.purchaseCost}
            onChange={(e) => set("purchaseCost", e.target.value)}
            error={errors.purchaseCost}
            hint="Per unit, before GST."
          />
          <AdminInput
            label="Minimum order quantity"
            required
            inputMode="numeric"
            value={draft.moq}
            onChange={(e) => set("moq", e.target.value)}
            error={errors.moq}
          />
          <AdminInput
            label="Lead time (days)"
            inputMode="numeric"
            value={draft.leadTimeDays}
            onChange={(e) => set("leadTimeDays", e.target.value)}
            error={errors.leadTimeDays}
            hint="Leave blank if you don't know."
          />
          <AdminSelect
            label="Link status"
            value={draft.status}
            onChange={(e) => set("status", e.target.value as SupplierProductStatus)}
            options={[
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive — not ordered from this supplier now" },
            ]}
          />
          <div className="self-end">
            <AdminCheckbox
              label="Preferred supplier for this product"
              description="Clears the flag on the product's other suppliers."
              checked={draft.preferred}
              onChange={(e) => set("preferred", e.target.checked)}
            />
          </div>
          <AdminTextarea label="Notes" rows={2} value={draft.notes} onChange={(e) => set("notes", e.target.value)} className="sm:col-span-2" />
        </FormGrid>

        <div className="flex justify-end gap-2">
          <AdminButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving}>
            {link ? "Save changes" : "Link product"}
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}
