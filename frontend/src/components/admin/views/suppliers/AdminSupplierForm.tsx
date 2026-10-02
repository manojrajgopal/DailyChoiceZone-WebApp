"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import type { SupplierAddress, TaxTreatment } from "@/types/suppliers";

import { AdminButton, AdminButtonLink, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { AdminCheckbox, AdminInput, AdminSelect, AdminTextarea, FormGrid, FormSection } from "@/components/admin/ui/AdminForm";
import { useAdminResource } from "@/hooks/useAdminResource";
import { createSupplier, getSupplier, updateSupplier } from "@/services/suppliersService";
import { toast } from "@/store/toastStore";

import {
  ADMIN_CRUMB,
  LoadFailed,
  NoAccess,
  PageSkeleton,
  SUPPLIERS_CRUMB,
  isForbidden,
  isNotFound,
  problem,
  serverFieldErrors,
} from "./shared";
import {
  type Errors,
  type SupplierDraft,
  draftFromSupplier,
  emptySupplierDraft,
  toSupplierInput,
  validateSupplier,
} from "./validation";

const TAX_TREATMENTS: { value: TaxTreatment; label: string }[] = [
  { value: "registered", label: "Registered (regular GST)" },
  { value: "composition", label: "Composition scheme" },
  { value: "unregistered", label: "Unregistered" },
  { value: "overseas", label: "Overseas" },
];

const BUSINESS_TYPES = [
  { value: "manufacturer", label: "Manufacturer" },
  { value: "wholesaler", label: "Wholesaler" },
  { value: "distributor", label: "Distributor" },
  { value: "trader", label: "Trader" },
  { value: "importer", label: "Importer" },
  { value: "other", label: "Other" },
];

/** Add (`/admin/suppliers/new`) or edit (`/admin/suppliers/edit?id=SUP001`) a supplier. */
export function AdminSupplierForm({ mode }: { mode: "create" | "edit" }) {
  const params = useSearchParams();
  const supplierId = mode === "edit" ? (params?.get("id") ?? "") : "";
  const existing = useAdminResource(() => getSupplier(supplierId), [supplierId], { enabled: mode === "edit" && Boolean(supplierId) });

  if (mode === "edit") {
    const crumbs = [ADMIN_CRUMB, SUPPLIERS_CRUMB, { label: "Edit" }];
    if (!supplierId || isNotFound(existing.error)) {
      return (
        <div>
          <AdminPageHeader title="Supplier not found" breadcrumbs={crumbs} />
          <p className="text-sm text-admin-muted">We couldn&rsquo;t find this supplier. The link may be out of date.</p>
          <AdminButtonLink href="/admin/suppliers" size="sm" className="mt-4">
            Back to suppliers
          </AdminButtonLink>
        </div>
      );
    }
    if (isForbidden(existing.error)) {
      return (
        <div>
          <AdminPageHeader title="Edit supplier" breadcrumbs={crumbs} />
          <NoAccess area="suppliers" />
        </div>
      );
    }
    if (existing.error && !existing.data) {
      return (
        <div>
          <AdminPageHeader title="Edit supplier" breadcrumbs={crumbs} />
          <LoadFailed message={problem(existing.error, "The supplier didn't load.")} onRetry={() => void existing.reload()} />
        </div>
      );
    }
    if (!existing.data) return <PageSkeleton label="Loading supplier" />;
    return <SupplierFormBody key={existing.data.id} mode="edit" supplierId={supplierId} initial={draftFromSupplier(existing.data)} title={`Edit ${existing.data.name}`} />;
  }

  return <SupplierFormBody mode="create" supplierId="" initial={emptySupplierDraft()} title="New supplier" />;
}

function SupplierFormBody({
  mode,
  supplierId,
  initial,
  title,
}: {
  mode: "create" | "edit";
  supplierId: string;
  initial: SupplierDraft;
  title: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<SupplierDraft>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  const clearError = (...keys: string[]) =>
    setErrors((current) => {
      if (!keys.some((key) => current[key])) return current;
      const next = { ...current };
      for (const key of keys) delete next[key];
      return next;
    });

  const set = <K extends keyof SupplierDraft>(key: K, value: SupplierDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    clearError(key as string);
  };

  const setAddress = (which: "billingAddress" | "warehouseAddress", key: keyof SupplierAddress, value: string) => {
    setDraft((current) => ({ ...current, [which]: { ...current[which], [key]: value } }));
    clearError(`${which}.${key}`);
  };

  const save = async () => {
    const found = validateSupplier(draft);
    setFormError("");
    if (Object.keys(found).length > 0) {
      setErrors(found);
      toast.error("Check the highlighted fields.");
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      const input = toSupplierInput(draft);
      const saved = mode === "create" ? await createSupplier(input) : await updateSupplier(supplierId, input);
      toast.success(mode === "create" ? `${saved.name} added` : "Supplier updated");
      router.push(`/admin/suppliers/detail?id=${encodeURIComponent(saved.id || supplierId)}`);
    } catch (error) {
      const fields = serverFieldErrors(error, { SUPPLIER_CODE_TAKEN: "code" });
      setErrors(fields);
      const message = problem(error, "The supplier wasn't saved. Please try again.");
      if (Object.keys(fields).length === 0) setFormError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const gstRequired = draft.taxTreatment === "registered";

  const address = (which: "billingAddress" | "warehouseAddress", heading: string) => {
    const value = draft[which];
    return (
      <FormGrid columns={3}>
        <AdminInput label={`${heading} line 1`} value={value.line1} onChange={(e) => setAddress(which, "line1", e.target.value)} className="sm:col-span-2 lg:col-span-3" />
        <AdminInput label={`${heading} line 2`} value={value.line2} onChange={(e) => setAddress(which, "line2", e.target.value)} className="sm:col-span-2 lg:col-span-3" />
        <AdminInput label={`${heading} city`} value={value.city} onChange={(e) => setAddress(which, "city", e.target.value)} />
        <AdminInput
          label={`${heading} state`}
          value={value.state}
          onChange={(e) => setAddress(which, "state", e.target.value)}
          hint={which === "billingAddress" ? "Decides CGST + SGST or IGST on purchase orders." : undefined}
        />
        <AdminInput label={`${heading} country`} value={value.country} onChange={(e) => setAddress(which, "country", e.target.value)} />
        <AdminInput
          label={`${heading} pincode`}
          value={value.pincode}
          inputMode="numeric"
          maxLength={10}
          onChange={(e) => setAddress(which, "pincode", e.target.value)}
          error={errors[`${which}.pincode`]}
        />
      </FormGrid>
    );
  };

  return (
    <div className="pb-20">
      <AdminPageHeader
        title={title}
        description={mode === "create" ? "Only the name is needed now; fill in the rest when you have it." : "Changes apply to new purchase orders."}
        breadcrumbs={[ADMIN_CRUMB, SUPPLIERS_CRUMB, { label: mode === "create" ? "New" : "Edit" }]}
      />

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="flex max-w-4xl flex-col gap-4"
        aria-label={title}
      >
        {formError ? (
          <p role="alert" className="rounded-[3px] border border-[#f1c4c4] bg-[#fbeaea] px-3 py-2 text-xs text-[#a12b2b]">
            {formError}
          </p>
        ) : null}

        <FormSection title="Supplier" description="How you refer to them, and who to talk to.">
          <FormGrid>
            <AdminInput
              label="Name"
              required
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              error={errors.name}
              placeholder="Anvi Textiles"
            />
            <AdminInput
              label="Code"
              value={draft.code}
              onChange={(e) => set("code", e.target.value.toUpperCase())}
              error={errors.code}
              className="font-mono"
              maxLength={30}
              hint={mode === "create" ? "Capital letters, digits and hyphens. Leave blank to generate one." : "Capital letters, digits and hyphens."}
              placeholder="ANVI-TEX"
            />
            <AdminInput label="Legal name" value={draft.legalName} onChange={(e) => set("legalName", e.target.value)} placeholder="Anvi Textiles Pvt Ltd" />
            <AdminSelect
              label="Business type"
              value={draft.businessType}
              onChange={(e) => set("businessType", e.target.value)}
              options={
                BUSINESS_TYPES.some((type) => type.value === draft.businessType) || !draft.businessType
                  ? BUSINESS_TYPES
                  : [...BUSINESS_TYPES, { value: draft.businessType, label: draft.businessType }]
              }
            />
            <AdminInput label="Contact person" value={draft.contactPerson} onChange={(e) => set("contactPerson", e.target.value)} />
            <AdminInput
              label="Phone"
              type="tel"
              value={draft.phone}
              onChange={(e) => set("phone", e.target.value)}
              error={errors.phone}
              hint="10 digits, or + and the country code."
            />
            <AdminInput label="Email" type="email" value={draft.email} onChange={(e) => set("email", e.target.value)} error={errors.email} />
            <AdminInput label="Website" type="url" value={draft.website} onChange={(e) => set("website", e.target.value)} error={errors.website} placeholder="https://" />
          </FormGrid>
        </FormSection>

        <FormSection title="Tax" description="Used to work out GST on purchase orders.">
          <FormGrid columns={3}>
            <AdminSelect
              label="Tax treatment"
              value={draft.taxTreatment}
              onChange={(e) => {
                set("taxTreatment", e.target.value as TaxTreatment);
                clearError("gstin");
              }}
              options={TAX_TREATMENTS}
            />
            <AdminInput
              label="GSTIN"
              required={gstRequired}
              value={draft.gstin}
              maxLength={15}
              className="font-mono"
              onChange={(e) => set("gstin", e.target.value.toUpperCase().trim())}
              error={errors.gstin}
              hint={gstRequired ? "Required for a registered supplier." : "Optional."}
              placeholder="29ABCDE1234F1Z5"
            />
            <AdminInput
              label="PAN"
              value={draft.pan}
              maxLength={10}
              className="font-mono"
              onChange={(e) => set("pan", e.target.value.toUpperCase().trim())}
              error={errors.pan}
              hint="Optional."
              placeholder="ABCDE1234F"
            />
          </FormGrid>
        </FormSection>

        <FormSection title="Billing address" description="The address on their invoices.">
          {address("billingAddress", "Billing")}
        </FormSection>

        <FormSection title="Warehouse" description="Where goods are dispatched from, when it isn't the billing address.">
          <AdminCheckbox
            label="Goods come from a different address"
            checked={draft.hasWarehouse}
            onChange={(e) => set("hasWarehouse", e.target.checked)}
          />
          {draft.hasWarehouse ? <div className="mt-3">{address("warehouseAddress", "Warehouse")}</div> : null}
        </FormSection>

        <FormSection title="Terms">
          <FormGrid columns={3}>
            <AdminInput label="Payment terms" value={draft.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} placeholder="Net 30" />
            <AdminInput
              label="Credit days"
              type="number"
              inputMode="numeric"
              min={0}
              max={365}
              value={draft.creditDays}
              onChange={(e) => set("creditDays", e.target.value)}
              error={errors.creditDays}
            />
            <AdminSelect
              label="Currency"
              value={draft.currency}
              onChange={(e) => set("currency", e.target.value)}
              options={draft.currency === "INR" ? [{ value: "INR", label: "INR — Indian rupee" }] : [{ value: "INR", label: "INR — Indian rupee" }, { value: draft.currency, label: draft.currency }]}
            />
            <AdminTextarea label="Notes" rows={3} value={draft.notes} onChange={(e) => set("notes", e.target.value)} className="sm:col-span-2 lg:col-span-3" />
          </FormGrid>
        </FormSection>

        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-admin-border bg-admin-surface/95 px-4 py-3 backdrop-blur-sm lg:left-60">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <AdminButtonLink
              href={mode === "create" ? "/admin/suppliers" : `/admin/suppliers/detail?id=${encodeURIComponent(supplierId)}`}
              variant="ghost"
            >
              Cancel
            </AdminButtonLink>
            <AdminButton type="submit" variant="primary" loading={saving}>
              {mode === "create" ? "Add supplier" : "Save changes"}
            </AdminButton>
          </div>
        </div>
      </form>
    </div>
  );
}
