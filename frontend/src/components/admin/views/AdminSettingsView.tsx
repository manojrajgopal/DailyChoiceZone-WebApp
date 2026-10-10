"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { StoreSettings } from "@/types/admin";

import { StoreAlertsSection } from "./settings/StoreAlertsSection";

import { AdminButton, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import {
  AdminInput,
  AdminSelect,
  AdminTextarea,
  AdminToggle,
  FormGrid,
  FormSection,
} from "@/components/admin/ui/AdminForm";
import {
  SettingsLayout,
  SettingsSaveBar,
  changed,
  useSettingsSection,
  type SettingsSection,
} from "@/components/admin/ui/SettingsLayout";
import { useAdminResource } from "@/hooks/useAdminResource";
import {
  getAccountSecuritySettings,
  saveAccountSecuritySettings,
  type AccountSecuritySettings,
} from "@/services/admin/operationsAdminService";
import { getSettings, saveSettings } from "@/services/admin/settingsAdminService";
import { ApiError } from "@/services/api/client";
import { toast } from "@/store/toastStore";

/**
 * Store settings.
 *
 * These values feed the storefront: the delivery thresholds here are the ones
 * the cart prices against, and the contact details are the ones in the footer.
 * That is the point of putting them in data rather than in code.
 */
const SECTION_IDS = ["general", "contact", "social", "shipping", "tax", "notifications", "accounts"];

export function AdminSettingsView() {
  const { data, isLoading, reload } = useAdminResource(() => getSettings(), []);

  const [draft, setDraft] = useState<StoreSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useSettingsSection(SECTION_IDS);

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

  const saved = data ?? draft;
  const sections: SettingsSection[] = [
    {
      id: "general",
      label: "General",
      group: "Store",
      dirty: changed(draft.general, saved.general),
      content: (
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
      ),
    },
    {
      id: "contact",
      label: "Contact",
      group: "Store",
      dirty: changed(draft.contact, saved.contact),
      content: (
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
      ),
    },
    {
      id: "social",
      label: "Social links",
      group: "Store",
      dirty: changed(draft.social, saved.social),
      content: (
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
      ),
    },
    {
      id: "shipping",
      label: "Shipping & returns",
      group: "Selling",
      dirty: changed(draft.shipping, saved.shipping) || changed(draft.returns, saved.returns),
      content: (
        <FormSection title="Shipping & returns" description="What the cart charges for delivery.">
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
      ),
    },
    {
      id: "tax",
      label: "Currency & tax",
      group: "Selling",
      dirty: changed(draft.currency, saved.currency) || changed(draft.tax, saved.tax),
      content: (
        <FormSection title="Currency & tax">
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
      ),
    },
    {
      id: "notifications",
      label: "Notifications",
      group: "Alerts",
      dirty: changed(draft.notifications, saved.notifications),
      content: (
        <div className="flex flex-col gap-4">
          <FormSection title="Customer emails" description="Emails your store sends to customers.">
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
                label="Marketing emails"
                checked={draft.notifications.marketingEmails}
                onChange={(marketingEmails) => patch("notifications", { marketingEmails })}
              />
            </div>
          </FormSection>
          <StoreAlertsSection
            value={draft.notifications}
            onChange={(next) => patch("notifications", next)}
          />
        </div>
      ),
    },
    {
      id: "accounts",
      label: "Account security",
      group: "Alerts",
      content: <AccountSecuritySection />,
    },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Store settings"
        description="These values drive the storefront — delivery thresholds, tax, contact details and social links. Saved changes go live straight away."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Store settings" }]}
      />

      <SettingsLayout label="Store settings sections" sections={sections} active={section} onChange={setSection} />

      <SettingsSaveBar
        dirtySections={sections.filter((entry) => entry.dirty).map((entry) => entry.label)}
        saving={saving}
        onSave={() => void onSave()}
        onDiscard={() => setDraft(data)}
        saveLabel="Save settings"
      />
    </div>
  );
}

/**
 * Password-reset and email-verification links. Saved on its own — it lives in
 * a separate document from the store settings above.
 */
function AccountSecuritySection() {
  const loaded = useAdminResource(getAccountSecuritySettings, []);
  const [draft, setDraft] = useState<AccountSecuritySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? loaded.data;

  const save = async () => {
    if (!value) return;
    setSaving(true);
    try {
      await saveAccountSecuritySettings(value);
      toast.success("Account security settings saved");
      setDraft(null);
      await loaded.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "The settings weren't saved.");
    } finally {
      setSaving(false);
    }
  };

  if (!value) {
    return <p className="text-sm text-admin-muted">{loaded.error ? "These settings didn't load." : "Loading…"}</p>;
  }
  return (
    <FormSection
      title="Account security"
      description="How long emailed account links work, and whether an unconfirmed email address can place orders."
    >
      <FormGrid>
        <AdminInput
          label="Password-reset links last (minutes)"
          type="number"
          min={10}
          max={1440}
          value={value.resetMinutes}
          onChange={(event) => setDraft({ ...value, resetMinutes: Number(event.target.value) })}
          hint="10 minutes to a day. Each link works once."
        />
        <AdminInput
          label="Email-confirmation links last (hours)"
          type="number"
          min={1}
          max={336}
          value={value.verificationHours}
          onChange={(event) => setDraft({ ...value, verificationHours: Number(event.target.value) })}
          hint="1 hour to 14 days."
        />
      </FormGrid>
      <div className="mt-4">
        <AdminToggle
          label="Require a confirmed email address to place an order"
          description="Customers who haven't clicked their confirmation link are asked to before checking out."
          checked={value.requireVerifiedEmailToOrder}
          onChange={(requireVerifiedEmailToOrder) => setDraft({ ...value, requireVerifiedEmailToOrder })}
        />
      </div>
      <div className="mt-5 flex gap-2">
        <AdminButton variant="primary" onClick={() => void save()} loading={saving} disabled={!draft}>
          Save account security
        </AdminButton>
        {draft ? (
          <AdminButton variant="ghost" onClick={() => setDraft(null)}>
            Discard
          </AdminButton>
        ) : null}
      </div>
    </FormSection>
  );
}
