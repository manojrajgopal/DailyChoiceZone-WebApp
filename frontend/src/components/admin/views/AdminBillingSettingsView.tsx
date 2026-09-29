"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { BillingConfig, PaymentMethodKey, TaxConfig } from "@/types";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import {
  AdminInput,
  AdminSelect,
  AdminTextarea,
  AdminToggle,
  FormGrid,
} from "@/components/admin/ui/AdminForm";
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

export function AdminBillingSettingsView() {
  const content = useSiteContent();
  const states = content?.states ?? [];
  const methods = content?.paymentMethods ?? [];

  const [billing, setBilling] = useState<BillingConfig | null>(null);
  const [tax, setTax] = useState<TaxConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([getBillingConfig(), getTaxConfig()]).then(([nextBilling, nextTax]) => {
      if (!active) return;
      setBilling(nextBilling);
      setTax(nextTax);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!billing || !tax) {
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
      toast.error("Enter the registered business name — it goes on every invoice.");
      return;
    }
    if (billing.invoice.prefix.trim().length < 2) {
      toast.error("Enter an invoice prefix.");
      return;
    }
    if (tax.enabled && tax.rates.igst <= 0) {
      toast.error("With tax enabled, the IGST rate must be above zero.");
      return;
    }

    setSaving(true);
    try {
      // Both or neither, as far as the person filling the form is concerned —
      // a failure that saved one half silently is the worst outcome here.
      await Promise.all([saveBillingConfig(billing), saveTaxConfig(tax)]);
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
        actions={
          <AdminButton variant="primary" onClick={() => void onSave()} disabled={saving}>
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            Save billing settings
          </AdminButton>
        }
      />

      <div className="flex flex-col gap-4">
        {/* -------------------------------------------------------- business */}
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

        {/* --------------------------------------------------------- invoice */}
        <AdminCard title="Invoice settings" description="Numbering, terms and the footer.">
          <FormGrid>
            <AdminInput
              label="Invoice prefix"
              value={billing.invoice.prefix}
              onChange={(event) => patchInvoice("prefix", event.target.value)}
              hint={`Produces ${billing.invoice.prefix}-${new Date().getFullYear()}-${String(billing.invoice.startNumber).padStart(billing.invoice.padding, "0")}`}
              required
            />
            <AdminInput
              label="Starting number"
              type="number"
              min={1}
              value={billing.invoice.startNumber}
              onChange={(event) => patchInvoice("startNumber", Number(event.target.value) || 1)}
              hint="Used for new invoices. Existing numbers never change."
            />
            <AdminInput
              label="Invoice number length"
              type="number"
              min={1}
              max={10}
              value={billing.invoice.padding}
              onChange={(event) => patchInvoice("padding", Number(event.target.value) || 1)}
            />
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
            <AdminInput
              label="Credit note prefix"
              value={billing.creditNote.prefix}
              onChange={(event) =>
                setBilling({
                  ...billing,
                  creditNote: { ...billing.creditNote, prefix: event.target.value },
                })
              }
            />
          </FormGrid>
        </AdminCard>

        {/* ------------------------------------------------------------- tax */}
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

        {/* -------------------------------------------------------- currency */}
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

        {/* --------------------------------------------------------- payment */}
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

        {/* ---------------------------------------------------------- refund */}
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

        <div className="flex justify-end pb-2">
          <AdminButton variant="primary" onClick={() => void onSave()} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            Save billing settings
          </AdminButton>
        </div>
      </div>
    </div>
  );
}
