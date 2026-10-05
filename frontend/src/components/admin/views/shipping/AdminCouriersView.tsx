"use client";

import { useState } from "react";
import { CheckCircle2, Copy, KeyRound, Lock, PlugZap, XCircle } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { FulfilmentSettingsPanel } from "@/components/admin/views/packing/FulfilmentSettingsPanel";
import { AdminInput, AdminSelect, AdminToggle, FormGrid, TagListInput } from "@/components/admin/ui/AdminForm";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { problem } from "@/components/admin/views/operations/shared";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDateTime } from "@/lib/support/format";
import { ApiError } from "@/services/api/client";
import { listShippingProviders, testShippingProvider, updateShippingProvider } from "@/services/shippingService";
import { toast } from "@/store/toastStore";
import type { ProviderOrigin, ProviderSettings, ProviderUpdate, ShippingProviderConfig } from "@/types/shipping";

import { EMPTY_PACKAGE, PackageFields, packageForm, validatePackage, type PackageErrors, type PackageForm } from "./shared";

const EMPTY_ORIGIN: ProviderOrigin = { name: "", phone: "", line1: "", line2: "", city: "", state: "", pincode: "" };

const ENVIRONMENT_LABELS: Record<string, string> = { production: "Production", sandbox: "Sandbox (testing)" };

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** A provider's settings with every field present, whatever the server left out. */
function normalise(settings: Partial<ProviderSettings> | null | undefined): ProviderSettings {
  return {
    defaultService: settings?.defaultService ?? "",
    services: settings?.services ?? [],
    pickupLocation: settings?.pickupLocation ?? "",
    origin: { ...EMPTY_ORIGIN, ...(settings?.origin ?? {}) },
    checkoutServiceability: Boolean(settings?.checkoutServiceability),
    defaultPackage: settings?.defaultPackage ?? null,
  };
}

/**
 * Courier providers: credentials, pickup origin, services and checkout
 * behaviour, one card each. Credentials are write-only — the page shows only
 * which are set, masked, and a blank field keeps what's stored.
 */
export function AdminCouriersView() {
  const providers = useAdminResource(() => listShippingProviders(), []);
  const [forbidden, setForbidden] = useState(false);
  // Bumped after a save, so every card starts again from what the server now holds
  // (making one provider the default changes the others).
  const [version, setVersion] = useState(0);

  const header = (
    <AdminPageHeader
      title="Couriers"
      description="Connect the couriers you ship with. Shipments are created from an order's page."
      breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Settings", href: "/admin/settings" }, { label: "Couriers" }]}
      actions={
        <AdminButtonLink href="/admin/shipments" size="sm" variant="ghost">
          View shipments
        </AdminButtonLink>
      }
    />
  );

  if (forbidden || isForbidden(providers.error)) {
    return (
      <div>
        {header}
        <AdminCard>
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-[3px] bg-admin-raised">
              <Lock className="h-4 w-4 text-admin-muted" strokeWidth={1.75} aria-hidden="true" />
            </span>
            <p className="mt-3 text-sm font-medium text-admin-ink">Only a super admin can change couriers</p>
            <p className="mt-1 max-w-sm text-xs text-admin-muted">
              Courier accounts and their credentials are kept to super admins. Ask one to connect or change a courier.
            </p>
          </div>
        </AdminCard>
      </div>
    );
  }

  return (
    <div>
      {header}

      <p className="mb-4 flex items-start gap-2 rounded-[3px] border border-admin-border bg-admin-raised px-3 py-2.5 text-xs leading-relaxed text-admin-muted">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        Credentials are stored encrypted and are never shown again — not even to you. Leave a credential blank to keep the saved one.
      </p>

      {providers.isLoading && !providers.data ? (
        <div className="flex flex-col gap-4" aria-label="Loading couriers">
          {[0, 1].map((index) => (
            <div key={index} className="h-40 animate-pulse rounded-[3px] border border-admin-border bg-admin-surface" />
          ))}
        </div>
      ) : providers.error && !providers.data ? (
        <AdminCard>
          <div className="py-8 text-center">
            <p className="text-sm text-admin-ink">{problem(providers.error, "Couriers didn't load.")}</p>
            <AdminButton size="sm" className="mt-3" onClick={() => void providers.reload()}>
              Try again
            </AdminButton>
          </div>
        </AdminCard>
      ) : providers.data && providers.data.length === 0 ? (
        <AdminCard>
          <p className="py-8 text-center text-sm text-admin-muted">No courier integrations are available.</p>
        </AdminCard>
      ) : (
        <div className="flex flex-col gap-4">
          {providers.data?.map((provider) => (
            <ProviderCard
              key={`${provider.code}-${version}`}
              provider={provider}
              onForbidden={() => setForbidden(true)}
              onSaved={async () => {
                await providers.reload();
                setVersion((value) => value + 1);
              }}
              onTested={() => void providers.reload()}
            />
          ))}
        </div>
      )}

      <div className="mt-6">
        <FulfilmentSettingsPanel />
      </div>
    </div>
  );
}

interface CardErrors {
  pincode?: string;
  phone?: string;
  defaultService?: string;
}

function ProviderCard({
  provider,
  onForbidden,
  onSaved,
  onTested,
}: {
  provider: ShippingProviderConfig;
  onForbidden: () => void;
  onSaved: () => Promise<void>;
  onTested: () => void;
}) {
  const [name, setName] = useState(provider.name);
  const [environment, setEnvironment] = useState(provider.environment || provider.environments[0] || "");
  const [active, setActive] = useState(provider.active);
  const [isDefault, setIsDefault] = useState(provider.isDefault);
  const [settings, setSettings] = useState(() => normalise(provider.settings));
  const [pkg, setPkg] = useState<PackageForm>(() => packageForm(provider.settings?.defaultPackage));
  const [pkgErrors, setPkgErrors] = useState<PackageErrors>({});
  // Never seeded from the server: secrets are typed, sent, and forgotten.
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<CardErrors>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  const showPickup = provider.code === "shiprocket" || provider.settings?.pickupLocation !== undefined;
  const busy = saving || testing;
  const setOrigin = (patch: Partial<ProviderOrigin>) => setSettings((current) => ({ ...current, origin: { ...current.origin, ...patch } }));

  const save = async () => {
    const next: CardErrors = {};
    const pincode = settings.origin.pincode.trim();
    if (pincode && !/^[1-9]\d{5}$/.test(pincode)) next.pincode = "A 6-digit PIN code.";
    const phone = settings.origin.phone.replace(/\D/g, "");
    if (settings.origin.phone.trim() && !/^\d{10}$/.test(phone)) next.phone = "A 10-digit phone number.";
    if (settings.defaultService && !settings.services.includes(settings.defaultService)) next.defaultService = "Pick one of the services.";

    const blankPackage = Object.values(pkg).every((value) => !value.trim());
    const pkgResult = blankPackage ? null : validatePackage(pkg, { requireAll: false });
    setErrors(next);
    setPkgErrors(pkgResult?.errors ?? {});
    if (Object.keys(next).length > 0 || (pkgResult && Object.keys(pkgResult.errors).length > 0)) {
      toast.error("Some fields need a look before saving.");
      return;
    }

    const typed = Object.fromEntries(Object.entries(credentials).filter(([, value]) => value.trim() !== ""));
    const { pickupLocation, ...rest } = settings;
    const patch: ProviderUpdate = {
      name: name.trim() || provider.name,
      environment,
      active,
      isDefault,
      settings: {
        ...rest,
        ...(showPickup ? { pickupLocation: (pickupLocation ?? "").trim() } : {}),
        origin: { ...settings.origin, phone: settings.origin.phone.trim() ? phone : "" },
        defaultPackage: pkgResult ? (pkgResult.value as ProviderSettings["defaultPackage"]) : null,
      },
      ...(Object.keys(typed).length > 0 ? { credentials: typed } : {}),
    };

    setSaving(true);
    try {
      await updateShippingProvider(provider.code, patch);
      setCredentials({});
      toast.success(`${provider.name} saved.`);
      await onSaved();
    } catch (error) {
      if (isForbidden(error)) onForbidden();
      else toast.error(problem(error, "The courier settings weren't saved. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const typed = Object.fromEntries(Object.entries(credentials).filter(([, value]) => value.trim() !== ""));
      const result = await testShippingProvider(provider.code, {
        ...(Object.keys(typed).length > 0 ? { credentials: typed } : {}),
        ...(environment ? { environment } : {}),
      });
      setTest(result);
      onTested();
    } catch (error) {
      if (isForbidden(error)) onForbidden();
      else setTest({ ok: false, message: problem(error, "The test couldn't run. Please try again.") });
    } finally {
      setTesting(false);
    }
  };

  const copyWebhook = async () => {
    try {
      await navigator.clipboard.writeText(provider.webhookUrl);
      toast.success("Webhook URL copied.");
    } catch {
      toast.error("Couldn't copy — select the address and copy it by hand.");
    }
  };

  return (
    <section aria-labelledby={`courier-${provider.code}`} className="rounded-[3px] border border-admin-border bg-admin-surface">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-admin-border px-4 py-3">
        <div className="min-w-0">
          <h2 id={`courier-${provider.code}`} className="font-sans text-sm font-semibold text-admin-ink">
            {provider.name}
          </h2>
          {provider.description ? <p className="mt-0.5 text-xs text-admin-muted">{provider.description}</p> : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {!provider.available ? <StatusBadge tone="neutral">Not available</StatusBadge> : null}
          <StatusBadge tone={provider.active ? "good" : "neutral"}>{provider.active ? "Active" : "Inactive"}</StatusBadge>
          {provider.isDefault ? <StatusBadge tone="info">Default</StatusBadge> : null}
          <StatusBadge tone={provider.configured ? "good" : "warning"}>{provider.configured ? "Configured" : "Not configured"}</StatusBadge>
        </div>
      </header>

      <form
        noValidate
        className="flex flex-col gap-6 p-4 sm:p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <FormGrid>
          <AdminInput label="Display name" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
          <AdminSelect
            label="Environment"
            value={environment}
            disabled={busy || provider.environments.length <= 1}
            hint={provider.environments.length <= 1 ? `${provider.name} offers ${ENVIRONMENT_LABELS[environment]?.toLowerCase() ?? environment} only.` : undefined}
            onChange={(event) => setEnvironment(event.target.value)}
            options={provider.environments.map((value) => ({ value, label: ENVIRONMENT_LABELS[value] ?? value }))}
          />
        </FormGrid>

        <div className="grid gap-x-6 sm:grid-cols-2">
          <AdminToggle
            label="Active"
            description="Offered when creating shipments. Needs its credentials set."
            checked={active}
            disabled={busy}
            onChange={setActive}
          />
          <AdminToggle
            label="Default courier"
            description="Preselected for new shipments. Only one courier is the default."
            checked={isDefault}
            disabled={busy}
            onChange={setIsDefault}
          />
          <AdminToggle
            label="Ask this courier at checkout"
            description="For PIN codes your own delivery list doesn't include. Checkout never waits on it."
            checked={settings.checkoutServiceability}
            disabled={busy}
            onChange={(checked) => setSettings((current) => ({ ...current, checkoutServiceability: checked }))}
          />
        </div>

        <div>
          <h3 className="mb-3 text-xs font-semibold text-admin-ink">Services</h3>
          <FormGrid>
            <TagListInput
              label="Services offered"
              hint="e.g. Surface, Express. Press Enter after each."
              values={settings.services}
              onChange={(services) =>
                setSettings((current) => ({
                  ...current,
                  services,
                  defaultService: services.includes(current.defaultService) ? current.defaultService : "",
                }))
              }
            />
            <AdminSelect
              label="Default service"
              placeholder="None"
              value={settings.defaultService}
              error={errors.defaultService}
              disabled={busy || settings.services.length === 0}
              onChange={(event) => setSettings((current) => ({ ...current, defaultService: event.target.value }))}
              options={settings.services.map((value) => ({ value, label: value }))}
            />
            {showPickup ? (
              <AdminInput
                label="Pickup location"
                hint="The pickup address nickname exactly as it's saved in Shiprocket."
                value={settings.pickupLocation ?? ""}
                disabled={busy}
                onChange={(event) => setSettings((current) => ({ ...current, pickupLocation: event.target.value }))}
              />
            ) : null}
          </FormGrid>
        </div>

        <div>
          <h3 className="mb-3 text-xs font-semibold text-admin-ink">Ships from</h3>
          <FormGrid columns={3}>
            <AdminInput label="Contact name" value={settings.origin.name} disabled={busy} onChange={(event) => setOrigin({ name: event.target.value })} />
            <AdminInput
              label="Phone"
              inputMode="tel"
              value={settings.origin.phone}
              error={errors.phone}
              disabled={busy}
              onChange={(event) => setOrigin({ phone: event.target.value })}
            />
            <AdminInput label="Address line 1" value={settings.origin.line1} disabled={busy} onChange={(event) => setOrigin({ line1: event.target.value })} />
            <AdminInput label="Address line 2" value={settings.origin.line2} disabled={busy} onChange={(event) => setOrigin({ line2: event.target.value })} />
            <AdminInput label="City" value={settings.origin.city} disabled={busy} onChange={(event) => setOrigin({ city: event.target.value })} />
            <AdminInput label="State" value={settings.origin.state} disabled={busy} onChange={(event) => setOrigin({ state: event.target.value })} />
            <AdminInput
              label="PIN code"
              inputMode="numeric"
              maxLength={6}
              value={settings.origin.pincode}
              error={errors.pincode}
              disabled={busy}
              onChange={(event) => setOrigin({ pincode: event.target.value })}
            />
          </FormGrid>
        </div>

        <div>
          <h3 className="text-xs font-semibold text-admin-ink">Default package</h3>
          <p className="mb-3 mt-0.5 text-[0.6875rem] text-admin-muted">
            Optional. Prefills the create-shipment form; leave it all blank to enter each package by hand.
          </p>
          <PackageFields
            form={pkg}
            errors={pkgErrors}
            requireAll={false}
            disabled={busy}
            onChange={(patch) => setPkg((current) => ({ ...current, ...patch }))}
          />
          {Object.values(pkg).some((value) => value.trim()) ? (
            <AdminButton size="sm" variant="ghost" className="mt-2" disabled={busy} onClick={() => setPkg(EMPTY_PACKAGE)}>
              Clear default package
            </AdminButton>
          ) : null}
        </div>

        {provider.credentialFields.length > 0 ? (
          <div>
            <h3 className="text-xs font-semibold text-admin-ink">Credentials</h3>
            <p className="mb-3 mt-0.5 text-[0.6875rem] text-admin-muted">
              Stored encrypted and never shown again. The placeholder shows which are set; leave a field blank to keep it.
            </p>
            {provider.code === "shiprocket" ? (
              <p className="mb-3 text-[0.6875rem] leading-relaxed text-admin-muted">
                These are not your Shiprocket login. In your Shiprocket account go to Settings → API → Configure → Create an
                API user, give it an email that is different from your login email, and enter that email and the password
                Shiprocket sends you here.
              </p>
            ) : null}
            <FormGrid>
              {provider.credentialFields.map((field) => (
                <AdminInput
                  key={field.key}
                  label={field.label}
                  type={field.secret ? "password" : "text"}
                  autoComplete="new-password"
                  spellCheck={false}
                  value={credentials[field.key] ?? ""}
                  placeholder={provider.credentials?.[field.key] || "Not set"}
                  disabled={busy}
                  onChange={(event) => setCredentials((current) => ({ ...current, [field.key]: event.target.value }))}
                />
              ))}
            </FormGrid>
          </div>
        ) : null}

        {provider.webhookUrl ? (
          <div>
            <h3 className="text-xs font-semibold text-admin-ink">Tracking webhook</h3>
            <p className="mb-2 mt-0.5 text-[0.6875rem] leading-relaxed text-admin-muted">
              In {provider.name}, add this address as the tracking webhook and set its token to the webhook token above. Updates then arrive as
              they happen instead of waiting for the next tracking check.
            </p>
            <div className="flex gap-2">
              <input
                readOnly
                aria-label={`${provider.name} webhook URL`}
                value={provider.webhookUrl}
                onFocus={(event) => event.target.select()}
                className="h-9 min-w-0 flex-1 rounded-[3px] border border-admin-border bg-admin-raised px-2.5 font-mono text-[0.75rem] text-admin-ink"
              />
              <AdminButton size="md" onClick={() => void copyWebhook()} aria-label="Copy webhook URL">
                <Copy className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Copy
              </AdminButton>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-admin-border pt-4">
          <div className="min-w-0 text-xs" aria-live="polite">
            {test ? (
              <p className={test.ok ? "flex items-start gap-1.5 text-[#0a6b0a]" : "flex items-start gap-1.5 text-[#a12b2b]"}>
                {test.ok ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                )}
                <span>
                  {test.ok ? "Connection works." : "Connection failed."}
                  {test.message ? ` ${test.message}` : ""}
                </span>
              </p>
            ) : null}
            <p className="mt-0.5 text-[0.6875rem] text-admin-muted">
              {provider.lastTestedAt
                ? `Last tested ${formatDateTime(provider.lastTestedAt)} — ${provider.lastTestOk ? "worked" : "failed"}${
                    !provider.lastTestOk && provider.lastError ? `: ${provider.lastError}` : ""
                  }`
                : "Not tested yet."}
            </p>
          </div>
          <div className="flex gap-2">
            <AdminButton loading={testing} disabled={saving} onClick={() => void runTest()}>
              {testing ? null : <PlugZap className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
              Test connection
            </AdminButton>
            <AdminButton type="submit" variant="primary" loading={saving} disabled={testing}>
              Save {provider.name}
            </AdminButton>
          </div>
        </div>
      </form>
    </section>
  );
}
