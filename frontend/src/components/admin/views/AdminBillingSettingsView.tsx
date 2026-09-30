"use client";

import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";

import type { BillingConfig, PaymentMethodKey, TaxConfig } from "@/types";

import { AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import {
  AdminInput,
  AdminSelect,
  AdminTextarea,
  AdminToggle,
  FormGrid,
} from "@/components/admin/ui/AdminForm";
import {
  SettingsLayout,
  SettingsSaveBar,
  changed,
  useSettingsSection,
  type SettingsSection,
} from "@/components/admin/ui/SettingsLayout";
import { formatMoney, toMinor } from "@/lib/money";
import { getBillingConfig, saveBillingConfig } from "@/services/billing/billingService";
import { useSiteContent } from "@/hooks/useSiteContent";
import { getTaxConfig, saveTaxConfig } from "@/services/billing/taxService";
import { toast } from "@/store/toastStore";

/**
 * Billing settings.
 *
 * Everything the invoice, the tax calculation and the checkout read is editable
 * here, because these are business decisions rather than code: a rate changes, a
 * registration number changes, the numbering series restarts each financial
 * year. A value that has to be edited in a source file is a value nobody without
 * the repository can fix.
 *
 * Two documents are saved together — the billing configuration and the tax
 * configuration. They are separate records because they change for different
 * reasons and a real business would have different people responsible for
 * each, but they are one form because nobody thinks of them separately while
 * setting up a store.
 */

const SECTION_IDS = ["business", "invoice", "numbers", "tax", "currency", "payment", "refund"];

export function AdminBillingSettingsView() {
  const content = useSiteContent();
  const states = content?.states ?? [];
  const methods = content?.paymentMethods ?? [];

  const [billing, setBilling] = useState<BillingConfig | null>(null);
  const [tax, setTax] = useState<TaxConfig | null>(null);
  // What the server holds — for marking unsaved sections and "Discard changes".
  const [savedBilling, setSavedBilling] = useState<BillingConfig | null>(null);
  const [savedTax, setSavedTax] = useState<TaxConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [section, setSection] = useSettingsSection(SECTION_IDS);

  useEffect(() => {
    let active = true;
    void Promise.all([getBillingConfig(), getTaxConfig()]).then(([nextBilling, nextTax]) => {
      if (!active) return;
      setBilling(nextBilling);
      setTax(nextTax);
      setSavedBilling(nextBilling);
      setSavedTax(nextTax);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!billing || !tax || !savedBilling || !savedTax) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-hidden="true" />
      </div>
    );
  }

  const patchBusiness = <K extends keyof BillingConfig["business"]>(
    key: K,
    value: BillingConfig["business"][K],
  ) => setBilling({ ...billing, business: { ...billing.business, [key]: value } });

  const patchInvoice = <K extends keyof BillingConfig["invoice"]>(
    key: K,
    value: BillingConfig["invoice"][K],
  ) => setBilling({ ...billing, invoice: { ...billing.invoice, [key]: value } });

  const patchCurrency = <K extends keyof BillingConfig["currency"]>(
    key: K,
    value: BillingConfig["currency"][K],
  ) => setBilling({ ...billing, currency: { ...billing.currency, [key]: value } });

  const onSave = async () => {
    if (billing.business.legalName.trim().length < 2) {
      setSection("business");
      toast.error("Enter the registered business name — it goes on every invoice.");
      return;
    }
    if (tax.enabled && tax.rates.igst <= 0) {
      setSection("tax");
      toast.error("With tax enabled, the IGST rate must be above zero.");
      return;
    }

    setSaving(true);
    try {
      // Both or neither, as far as the person filling the form is concerned —
      // a failure that saved one half silently is the worst outcome here.
      await Promise.all([saveBillingConfig(billing), saveTaxConfig(tax)]);
      setSavedBilling(billing);
      setSavedTax(tax);
      toast.success("Billing settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Those settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  /**
   * CGST and SGST are each half of the combined rate, so editing one moves the
   * other. Letting them drift apart would produce an invoice whose halves do
   * not add up to the rate it claims.
   */
  const setHalfRate = (value: number) =>
    setTax({ ...tax, rates: { ...tax.rates, cgst: value, sgst: value, igst: value * 2 } });

  const sections: SettingsSection[] = [
    {
      id: "business",
      label: "Business details",
      group: "Business",
      dirty: changed(billing.business, savedBilling.business),
      content: (
        <AdminCard title="Business information" description="Printed on every invoice and credit note.">
          <FormGrid>
            <AdminInput
              label="Registered business name"
              value={billing.business.legalName}
              onChange={(event) => patchBusiness("legalName", event.target.value)}
              required
              className="sm:col-span-2"
            />
            <AdminInput
              label="Store name"
              value={billing.business.storeName}
              onChange={(event) => patchBusiness("storeName", event.target.value)}
            />
            <AdminInput
              label="Website"
              value={billing.business.website}
              onChange={(event) => patchBusiness("website", event.target.value)}
            />
            <AdminInput
              label="Billing email"
              type="email"
              value={billing.business.email}
              onChange={(event) => patchBusiness("email", event.target.value)}
            />
            <AdminInput
              label="Phone"
              value={billing.business.phone}
              onChange={(event) => patchBusiness("phone", event.target.value)}
            />
            <AdminInput
              label="Address line 1"
              value={billing.business.addressLine1}
              onChange={(event) => patchBusiness("addressLine1", event.target.value)}
              className="sm:col-span-2"
            />
            <AdminInput
              label="Address line 2"
              value={billing.business.addressLine2}
              onChange={(event) => patchBusiness("addressLine2", event.target.value)}
              className="sm:col-span-2"
            />
            <AdminInput
              label="City"
              value={billing.business.city}
              onChange={(event) => patchBusiness("city", event.target.value)}
            />
            <AdminInput
              label="Postal code"
              value={billing.business.postalCode}
              onChange={(event) => patchBusiness("postalCode", event.target.value)}
            />
            <AdminSelect
              label="State"
              value={billing.business.state}
              onChange={(event) => patchBusiness("state", event.target.value)}
              options={states.map((state) => ({ value: state, label: state }))}
            />
            <AdminInput
              label="Country"
              value={billing.business.country}
              onChange={(event) => patchBusiness("country", event.target.value)}
            />
          </FormGrid>
        </AdminCard>
      ),
    },
    {
      id: "invoice",
      label: "Invoice terms",
      group: "Business",
      dirty: changed(billing.invoice, savedBilling.invoice),
      content: (
        <AdminCard title="Invoice terms" description="Payment terms, notes and the footer printed on every invoice.">
          <FormGrid>
            <AdminInput
              label="Payment due (days)"
              type="number"
              min={0}
              value={billing.invoice.dueDays}
              onChange={(event) => patchInvoice("dueDays", Number(event.target.value) || 0)}
              hint="An unpaid invoice is shown as overdue after this."
            />
            <AdminTextarea
              label="Payment terms"
              rows={2}
              value={billing.invoice.paymentTerms}
              onChange={(event) => patchInvoice("paymentTerms", event.target.value)}
              className="sm:col-span-2"
            />
            <AdminTextarea
              label="Invoice notes"
              rows={2}
              value={billing.invoice.notes}
              onChange={(event) => patchInvoice("notes", event.target.value)}
              className="sm:col-span-2"
            />
            <AdminInput
              label="Invoice footer"
              value={billing.invoice.footer}
              onChange={(event) => patchInvoice("footer", event.target.value)}
              className="sm:col-span-2"
            />
          </FormGrid>
        </AdminCard>
      ),
    },
    {
      id: "numbers",
      label: "Document numbers",
      group: "Business",
      content: <DocumentNumbers billing={billing} />,
    },
    {
      id: "tax",
      label: "Tax",
      group: "Tax & money",
      dirty: changed(tax, savedTax),
      content: (
        <AdminCard
          title="Tax settings"
          description="How GST is applied to your orders."
        >
          <div className="flex flex-col gap-4">
            <AdminToggle
              label="Charge tax"
              description="Off means no tax lines anywhere and a zero tax total on every invoice."
              checked={tax.enabled}
              onChange={(checked) => setTax({ ...tax, enabled: checked })}
            />

            <AdminToggle
              label="Catalogue prices include tax"
              description="When on, your prices already include tax. When off, tax is added at checkout, which changes what customers pay."
              checked={tax.pricesIncludeTax}
              onChange={(checked) => setTax({ ...tax, pricesIncludeTax: checked })}
            />

            <FormGrid>
              <AdminInput
                label="GSTIN"
                value={tax.gstin}
                onChange={(event) => setTax({ ...tax, gstin: event.target.value })}
                hint="Shown on invoices. Please double-check it is correct."
              />
              <AdminSelect
                label="State of registration"
                value={tax.originState}
                onChange={(event) => setTax({ ...tax, originState: event.target.value })}
                options={states.map((state) => ({ value: state, label: state }))}
                hint="Supply inside this state is CGST + SGST; outside it is IGST."
              />
              <AdminInput
                label="CGST / SGST each (%)"
                type="number"
                min={0}
                step={0.5}
                value={tax.rates.cgst}
                onChange={(event) => setHalfRate(Number(event.target.value) || 0)}
                hint="Also updates the IGST rate to match."
              />
              <AdminInput
                label="IGST (%)"
                type="number"
                min={0}
                step={0.5}
                value={tax.rates.igst}
                onChange={(event) =>
                  setTax({ ...tax, rates: { ...tax.rates, igst: Number(event.target.value) || 0 } })
                }
                hint="Normally CGST + SGST."
              />
            </FormGrid>

            <p className="rounded-[3px] border border-status-warning/40 bg-status-warning/10 p-3 text-[0.6875rem] leading-relaxed text-admin-ink">
              <strong className="font-medium">These settings help calculate GST on your
              invoices.</strong>{" "}
              Tax treatment can also depend on HSN classification, exemptions and
              place-of-supply rules, so please confirm your rates and filings with your tax
              adviser.
            </p>

            {tax.categoryRates && Object.keys(tax.categoryRates).length > 0 ? (
              <div>
                <p className="mb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
                  Category overrides
                </p>
                <ul className="flex flex-col divide-y divide-admin-border rounded-[3px] border border-admin-border">
                  {Object.entries(tax.categoryRates).map(([category, rates]) => (
                    <li
                      key={category}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                    >
                      <span className="capitalize text-admin-ink">{category}</span>
                      <span className="tabular-nums text-admin-muted">
                        {rates.cgst}% + {rates.sgst}% · IGST {rates.igst}%
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[0.6875rem] text-admin-faint">
                  Category rates are set up for your store. Contact support if one needs to
                  change.
                </p>
              </div>
            ) : null}
          </div>
        </AdminCard>
      ),
    },
    {
      id: "currency",
      label: "Currency",
      group: "Tax & money",
      dirty: changed(billing.currency, savedBilling.currency),
      content: (
        <AdminCard title="Currency" description="The currency used on invoices.">
          <FormGrid>
            <AdminInput
              label="Currency code"
              value={billing.currency.code}
              onChange={(event) => patchCurrency("code", event.target.value.toUpperCase())}
            />
            <AdminInput
              label="Symbol"
              value={billing.currency.symbol}
              onChange={(event) => patchCurrency("symbol", event.target.value)}
            />
            <AdminInput
              label="Locale"
              value={billing.currency.locale}
              onChange={(event) => patchCurrency("locale", event.target.value)}
              hint="Sets how amounts are written, e.g. 1,00,000 for India."
            />
            <AdminInput
              label="Decimal places"
              type="number"
              min={0}
              max={4}
              value={billing.currency.decimals}
              onChange={(event) => patchCurrency("decimals", Number(event.target.value) || 0)}
              hint="Number of decimal places shown on invoices."
            />
          </FormGrid>
        </AdminCard>
      ),
    },
    {
      id: "payment",
      label: "Payment methods",
      group: "Checkout",
      dirty: changed(billing.payment, savedBilling.payment),
      content: (
        <AdminCard title="Payment settings" description="What a customer can pay with.">
          <div className="flex flex-col gap-3">
            {methods.map(({ id, label }) => {
              const method = id as PaymentMethodKey;
              const enabled = billing.payment.enabledMethods.includes(method);
              return (
                <AdminToggle
                  key={method}
                  label={label}
                  checked={enabled}
                  onChange={(checked) =>
                    setBilling({
                      ...billing,
                      payment: {
                        ...billing.payment,
                        enabledMethods: checked
                          ? [...billing.payment.enabledMethods, method]
                          : billing.payment.enabledMethods.filter((entry) => entry !== method),
                      },
                    })
                  }
                />
              );
            })}

            <AdminInput
              label="Cash on delivery fee (₹)"
              type="number"
              min={0}
              value={Math.round(billing.payment.codFee / 100)}
              onChange={(event) =>
                setBilling({
                  ...billing,
                  payment: { ...billing.payment, codFee: toMinor(Number(event.target.value) || 0) },
                })
              }
              hint={`Added to the order as a separate charge. Currently ${formatMoney(billing.payment.codFee)}.`}
              className="max-w-xs"
            />

            <p className="text-[0.6875rem] leading-relaxed text-admin-faint">
              Choose which payment methods customers see at checkout. Each method must also be
              switched on in your Razorpay account to work.
            </p>
          </div>
        </AdminCard>
      ),
    },
    {
      id: "refund",
      label: "Refunds",
      group: "Checkout",
      dirty: changed(billing.refund, savedBilling.refund),
      content: (
        <AdminCard title="Refund settings">
          <FormGrid>
            <AdminInput
              label="Refund window (days)"
              type="number"
              min={0}
              value={billing.refund.windowDays}
              onChange={(event) =>
                setBilling({
                  ...billing,
                  refund: { ...billing.refund, windowDays: Number(event.target.value) || 0 },
                })
              }
            />
            <div className="flex items-end">
              <AdminToggle
                label="Refund shipping on a whole-order refund"
                description="Include the delivery charge when refunding a whole order."
                checked={billing.refund.refundShipping}
                onChange={(checked) =>
                  setBilling({
                    ...billing,
                    refund: { ...billing.refund, refundShipping: checked },
                  })
                }
              />
            </div>
            <AdminTextarea
              label="Refund reasons"
              rows={4}
              value={billing.refund.reasons.join("\n")}
              onChange={(event) =>
                setBilling({
                  ...billing,
                  refund: {
                    ...billing.refund,
                    reasons: event.target.value
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean),
                  },
                })
              }
              hint="One per line. These are the options offered when raising a refund."
              className="sm:col-span-2"
            />
          </FormGrid>
        </AdminCard>
      ),
    },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Billing settings"
        description="The business details, numbering, tax treatment and payment options behind every invoice."
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Store settings", href: "/admin/settings" },
          { label: "Billing" },
        ]}
      />

      <SettingsLayout label="Billing settings sections" sections={sections} active={section} onChange={setSection} />

      <SettingsSaveBar
        dirtySections={sections.filter((entry) => entry.dirty).map((entry) => entry.label)}
        saving={saving}
        onSave={() => void onSave()}
        onDiscard={() => {
          setBilling(savedBilling);
          setTax(savedTax);
        }}
        saveLabel="Save billing settings"
      />
    </div>
  );
}

/**
 * The formats of every number the store issues — shown, never edited.
 *
 * They are fixed on the server (`app/core/numbering.py`): a changed prefix or
 * a restarted count would let a new number collide with an old one and break
 * the continuous series tax invoices need. Numbers simply grow a digit when
 * they need one; there is no length to run out of.
 */
function DocumentNumbers({ billing }: { billing: BillingConfig }) {
  const year = new Date().getFullYear();
  const yearly = (prefix: string, digits: number) => `${prefix}-${year}-${"1".padStart(digits, "0")}`;
  const rows = [
    { label: "Orders", example: `${billing.order.prefix}${billing.order.startNumber}` },
    { label: "Invoices", example: yearly(billing.invoice.prefix, billing.invoice.padding) },
    { label: "Credit notes", example: yearly(billing.creditNote.prefix, billing.creditNote.padding) },
    { label: "Refunds", example: yearly(billing.refund.prefix ?? "DCZ-RF", billing.refund.padding ?? 5) },
    { label: "Generated SKUs", example: `${billing.sku.prefix}-AC0001` },
  ];

  return (
    <AdminCard
      title="Document numbers"
      description="How orders, invoices, credit notes, refunds and SKUs are numbered."
    >
      <div className="mb-4 flex items-start gap-2.5 rounded-[3px] border border-admin-border bg-admin-raised p-3">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-admin-muted" strokeWidth={1.75} aria-hidden="true" />
        <p className="text-xs leading-relaxed text-admin-muted">
          These formats are fixed and can&rsquo;t be changed by anyone, so every number stays unique and your invoice
          series stays continuous. Each number counts up from the last one issued and simply grows longer when it needs
          to — there is no length limit.
        </p>
      </div>
      <dl className="divide-y divide-admin-border rounded-[3px] border border-admin-border">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-4 px-3 py-2.5">
            <dt className="text-xs text-admin-muted">{row.label}</dt>
            <dd className="font-mono text-[0.8125rem] text-admin-ink">{row.example}</dd>
          </div>
        ))}
      </dl>
    </AdminCard>
  );
}
