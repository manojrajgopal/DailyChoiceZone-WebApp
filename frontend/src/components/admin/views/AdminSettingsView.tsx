"use client";

import { useEffect, useState } from "react";
import { Database, Loader2 } from "lucide-react";

import type { StoreSettings } from "@/types/admin";

import { AdminButton, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import {
  AdminInput,
  AdminSelect,
  AdminTextarea,
  AdminToggle,
  FormGrid,
  FormSection,
} from "@/components/admin/ui/AdminForm";
import { useAdminResource } from "@/hooks/useAdminResource";
import { getSettings, saveSettings } from "@/services/admin/settingsAdminService";
import { toast } from "@/store/toastStore";

/**
 * Store settings.
 *
 * These values feed the storefront: the delivery thresholds here are the ones
 * the cart prices against, and the contact details are the ones in the footer.
 * That is the point of putting them in data rather than in code.
 */
export function AdminSettingsView() {
  const { data, isLoading, reload } = useAdminResource(() => getSettings(), []);

  const [draft, setDraft] = useState<StoreSettings | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * Seed the form whenever the settings are (re)loaded.
   *
   * Seeding only while the draft is null looks safer but is wrong here: a
   * reset clears the draft and starts a reload, and the effect would re-seed
   * from the *stale* settings on the render in between — leaving the form
   * showing values that no longer exist, ready to be saved back.
   *
   * Reloads happen only after a save (where the draft already equals the
   * data) and after a reset (where replacing the draft is the whole point),
   * so re-seeding on each one cannot discard an edit in progress.
   */
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);


  const onSave = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await saveSettings(draft);
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success("Store settings saved");
    await reload();
  };

  if (isLoading || !draft) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading settings" />
      </div>
    );
  }

  /** Update one nested settings group. */
  const patch = <K extends keyof StoreSettings>(key: K, value: Partial<StoreSettings[K]>) =>
    setDraft({ ...draft, [key]: { ...draft[key], ...value } });

  return (
    <div className="pb-24">
      <AdminPageHeader
        title="Store settings"
        description="These values drive the storefront — delivery thresholds, tax, contact details and social links."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Store settings" }]}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        {/* -------------------------------------------------------- general */}
        <FormSection title="General" description="How the store presents itself.">
          <FormGrid>
            <AdminInput
              label="Store name"
              value={draft.general.storeName}
              onChange={(event) => patch("general", { storeName: event.target.value })}
              required
              className="sm:col-span-2"
            />
            <AdminInput
              label="Tagline"
              value={draft.general.tagline}
              onChange={(event) => patch("general", { tagline: event.target.value })}
              className="sm:col-span-2"
            />
            <AdminTextarea
              label="Description"
              rows={3}
              value={draft.general.description}
              onChange={(event) => patch("general", { description: event.target.value })}
              className="sm:col-span-2"
              hint="Shown in search engine results."
            />
          </FormGrid>
        </FormSection>

        {/* -------------------------------------------------------- contact */}
        <FormSection title="Contact" description="Shown in the footer and on the contact page.">
          <FormGrid>
            <AdminInput
              label="Support email"
              type="email"
              value={draft.contact.email}
              onChange={(event) => patch("contact", { email: event.target.value })}
              required
            />
            <AdminInput
              label="Support phone"
              value={draft.contact.phone}
              onChange={(event) => patch("contact", { phone: event.target.value })}
            />
            <AdminInput
              label="Support hours"
              value={draft.contact.supportHours}
              onChange={(event) => patch("contact", { supportHours: event.target.value })}
              className="sm:col-span-2"
            />
            <AdminInput
              label="Address"
              value={draft.contact.addressLine}
              onChange={(event) => patch("contact", { addressLine: event.target.value })}
              className="sm:col-span-2"
            />
            <AdminInput
              label="City"
              value={draft.contact.city}
              onChange={(event) => patch("contact", { city: event.target.value })}
            />
            <AdminInput
              label="State"
              value={draft.contact.state}
              onChange={(event) => patch("contact", { state: event.target.value })}
            />
            <AdminInput
              label="PIN code"
              value={draft.contact.pincode}
              onChange={(event) => patch("contact", { pincode: event.target.value })}
            />
            <AdminInput
              label="Country"
              value={draft.contact.country}
              onChange={(event) => patch("contact", { country: event.target.value })}
            />
          </FormGrid>
        </FormSection>

        {/* ------------------------------------------------------- shipping */}
        <FormSection title="Shipping" description="What the cart charges for delivery.">
          <FormGrid>
            <AdminInput
              label="Free delivery above"
              type="number"
              min={0}
              prefix="₹"
              value={draft.shipping.freeDeliveryThreshold}
              onChange={(event) =>
                patch("shipping", { freeDeliveryThreshold: Number(event.target.value) })
              }
              hint="Applies to standard delivery only."
            />
            <AdminInput
              label="Standard delivery fee"
              type="number"
              min={0}
              prefix="₹"
              value={draft.shipping.standardFee}
              onChange={(event) => patch("shipping", { standardFee: Number(event.target.value) })}
            />
            <AdminInput
              label="Express delivery fee"
              type="number"
              min={0}
              prefix="₹"
              value={draft.shipping.expressFee}
              onChange={(event) => patch("shipping", { expressFee: Number(event.target.value) })}
              hint="Always charged — an upgrade is not covered by the threshold."
            />
            <AdminInput
              label="Standard estimate"
              value={draft.shipping.standardEstimate}
              onChange={(event) =>
                patch("shipping", { standardEstimate: event.target.value })
              }
            />
            <AdminInput
              label="Express estimate"
              value={draft.shipping.expressEstimate}
              onChange={(event) => patch("shipping", { expressEstimate: event.target.value })}
            />
            <AdminInput
              label="Return window"
              type="number"
              min={0}
              value={draft.returns.windowDays}
              onChange={(event) => patch("returns", { windowDays: Number(event.target.value) })}
              hint="Days after delivery."
            />
          </FormGrid>
        </FormSection>

        {/* ------------------------------------------------ currency and tax */}
        <FormSection title="Currency and tax">
          <FormGrid>
            <AdminSelect
              label="Currency"
              value={draft.currency.code}
              onChange={() => undefined}
              disabled
              options={[{ value: "INR", label: "Indian Rupee (₹)" }]}
              hint="Prices are shown in Indian Rupees."
            />
            <AdminInput
              label="Locale"
              value={draft.currency.locale}
              onChange={(event) => patch("currency", { locale: event.target.value })}
              hint="How numbers and dates are written."
            />
            <AdminInput
              label="GSTIN"
              value={draft.tax.gstin}
              onChange={(event) => patch("tax", { gstin: event.target.value })}
              className="sm:col-span-2"
            />
            <AdminInput
              label="Tax rate"
              type="number"
              min={0}
              max={28}
              value={draft.tax.ratePercent}
              onChange={(event) => patch("tax", { ratePercent: Number(event.target.value) })}
              hint="Percent."
            />
          </FormGrid>

          <div className="mt-3 flex flex-col divide-y divide-admin-border">
            <AdminToggle
              label="Tax enabled"
              description="Include a tax line on orders."
              checked={draft.tax.enabled}
              onChange={(enabled) => patch("tax", { enabled })}
            />
            <AdminToggle
              label="Prices include tax"
              description="Displayed prices are tax-inclusive, as is standard in India."
              checked={draft.tax.pricesIncludeTax}
              onChange={(pricesIncludeTax) => patch("tax", { pricesIncludeTax })}
            />
          </div>
        </FormSection>

        {/* -------------------------------------------------- notifications */}
        <FormSection
          title="Notifications"
          description="Choose which emails your store sends to customers and staff."
        >
          <div className="flex flex-col divide-y divide-admin-border">
            <AdminToggle
              label="Order confirmations"
              checked={draft.notifications.orderConfirmation}
              onChange={(orderConfirmation) => patch("notifications", { orderConfirmation })}
            />
            <AdminToggle
              label="Shipping updates"
              checked={draft.notifications.shippingUpdates}
              onChange={(shippingUpdates) => patch("notifications", { shippingUpdates })}
            />
            <AdminToggle
              label="Low stock alerts"
              description="Notify admins when a product falls below its threshold."
              checked={draft.notifications.lowStockAlerts}
              onChange={(lowStockAlerts) => patch("notifications", { lowStockAlerts })}
            />
            <AdminToggle
              label="Review alerts"
              description="Notify admins when a review needs moderating."
              checked={draft.notifications.reviewAlerts}
              onChange={(reviewAlerts) => patch("notifications", { reviewAlerts })}
            />
            <AdminToggle
              label="Marketing emails"
              checked={draft.notifications.marketingEmails}
              onChange={(marketingEmails) => patch("notifications", { marketingEmails })}
            />
          </div>
        </FormSection>

        {/* --------------------------------------------------------- social */}
        <FormSection title="Social links" description="Shown in the storefront footer.">
          <FormGrid columns={1}>
            <AdminInput
              label="Instagram"
              type="url"
              value={draft.social.instagram}
              onChange={(event) => patch("social", { instagram: event.target.value })}
            />
            <AdminInput
              label="Facebook"
              type="url"
              value={draft.social.facebook}
              onChange={(event) => patch("social", { facebook: event.target.value })}
            />
            <AdminInput
              label="YouTube"
              type="url"
              value={draft.social.youtube}
              onChange={(event) => patch("social", { youtube: event.target.value })}
            />
          </FormGrid>
        </FormSection>

        {/* ---------------------------------------------- where this lives */}
        <FormSection
          title="Saving changes"
          description="Changes go live straight away."
          className="xl:col-span-2"
        >
          <div className="flex max-w-prose items-start gap-2.5 rounded-[3px] border border-admin-border bg-admin-surface p-3.5">
            <Database
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-admin-faint"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <p className="text-xs leading-relaxed text-admin-muted">
              Changes you save here appear on your storefront immediately, for every shopper on
              every device.
            </p>
          </div>
        </FormSection>
      </div>

      {/* --------------------------------------------------- sticky actions */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-admin-border bg-admin-surface/95 px-4 py-3 backdrop-blur-sm lg:left-60">
        <div className="flex items-center justify-end gap-2">
          <AdminButton variant="ghost" onClick={() => setDraft(data)}>
            Discard changes
          </AdminButton>
          <AdminButton variant="primary" loading={saving} onClick={() => void onSave()}>
            Save settings
          </AdminButton>
        </div>
      </div>

    </div>
  );
}
