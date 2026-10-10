"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { AdminInput, AdminSelect } from "@/components/admin/ui/AdminForm";
import { problem } from "@/components/admin/views/operations/shared";
import { IdSelector } from "@/components/common/IdSelector";
import { Modal } from "@/components/ui/Dialog";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import { ApiError } from "@/services/api/client";
import { createShipment, getShippingRates, newIdempotencyKey } from "@/services/shippingService";
import { toast } from "@/store/toastStore";
import type { OrderShipping, RateOption, Shipment } from "@/types/shipping";

import { PackageFields, formatEta, packageForm, validatePackage, type PackageErrors, type PackageForm } from "./shared";

/**
 * Hand an order to a courier.
 *
 * Rendered only while open, so every opening gets one fresh idempotency key:
 * a double click, or a retry after a dropped connection, sends the same key
 * and the server answers with the same shipment instead of booking twice.
 */
export function CreateShipmentDialog({
  orderId,
  shipping,
  onClose,
  onCreated,
}: {
  orderId: string;
  shipping: OrderShipping;
  onClose: () => void;
  onCreated: (shipment: Shipment) => void;
}) {
  const [idempotencyKey] = useState(newIdempotencyKey);
  const providers = shipping.providers;
  const initial = providers.find((provider) => provider.isDefault) ?? providers[0];

  const [providerCode, setProviderCode] = useState(initial?.code ?? "");
  const provider = providers.find((entry) => entry.code === providerCode);
  const isManual = Boolean(provider?.supports.manualAwb);
  const [service, setService] = useState(initial?.services.length === 1 ? initial.services[0]! : "");
  const [courierName, setCourierName] = useState("");
  const [awb, setAwb] = useState("");
  // The packed parcels come first (docs/order-fulfilment.md): what the warehouse weighed and measured.
  const packed = shipping.packing?.package ?? null;
  const [pkg, setPkg] = useState<PackageForm>(() => packageForm(packed ?? shipping.defaultPackage));
  const [errors, setErrors] = useState<PackageErrors & { service?: string; courierName?: string; awb?: string; provider?: string }>({});
  const [rates, setRates] = useState<RateOption[] | null>(null);
  const [ratesError, setRatesError] = useState("");
  const [loadingRates, setLoadingRates] = useState(false);
  const [courier, setCourier] = useState<RateOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<{ message: string; code: string } | null>(null);

  const switchProvider = (code: string) => {
    setProviderCode(code);
    const next = providers.find((entry) => entry.code === code);
    setService(next?.services.length === 1 ? next.services[0]! : "");
    setRates(null);
    setCourier(null);
    setRatesError("");
    setErrors({});
  };

  const updatePackage = (patch: Partial<PackageForm>) => {
    setPkg((current) => ({ ...current, ...patch }));
    // A rate is quoted for a package; a different package needs a new quote.
    if (rates) {
      setRates(null);
      setCourier(null);
    }
  };

  const fetchRates = async () => {
    if (!provider) return;
    const result = validatePackage(pkg, { requireAll: true });
    const dimensionErrors: PackageErrors = {
      weightGrams: result.errors.weightGrams,
      lengthCm: result.errors.lengthCm,
      widthCm: result.errors.widthCm,
      heightCm: result.errors.heightCm,
    };
    if (Object.values(dimensionErrors).some(Boolean)) {
      setErrors((current) => ({ ...current, ...dimensionErrors }));
      setRatesError("Enter the weight and all three dimensions to get rates.");
      return;
    }
    setLoadingRates(true);
    setRatesError("");
    try {
      const { weightGrams, lengthCm, widthCm, heightCm } = result.value;
      const answer = await getShippingRates(orderId, { providerCode: provider.code, package: { weightGrams, lengthCm, widthCm, heightCm } });
      setRates(answer.options);
      setCourier(null);
    } catch (error) {
      setRates(null);
      setRatesError(
        error instanceof ApiError && error.code === "COURIER_UNAVAILABLE"
          ? "The courier couldn't be reached for rates. You can still create the shipment and let the courier assign one."
          : problem(error, "Rates didn't load. Please try again."),
      );
    } finally {
      setLoadingRates(false);
    }
  };

  const submit = async () => {
    if (submitting || !provider) return;
    const result = validatePackage(pkg, { requireAll: !isManual });
    const next: typeof errors = { ...result.errors };
    if (provider.services.length > 0 && !service) next.service = "Choose a service.";
    if (isManual) {
      if (!courierName.trim()) next.courierName = "Enter the courier's name.";
      if (!awb.trim()) next.awb = "Enter the AWB / tracking number.";
      else if (!/^[A-Za-z0-9-]{4,40}$/.test(awb.trim())) next.awb = "4 to 40 letters, digits or hyphens.";
    }
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setSubmitting(true);
    setServerError(null);
    try {
      const created = await createShipment({
        orderId,
        providerCode: provider.code,
        service,
        ...(isManual ? { courierName: courierName.trim(), awb: awb.trim() } : courier ? { courierCode: courier.courierCode } : {}),
        package: result.value,
        idempotencyKey,
      });
      if (created.technical?.requestStatus === "failed") {
        toast.error(
          `Shipment ${created.shipmentNumber} is saved, but ${provider.name} didn't accept it${
            created.technical.lastError ? `: ${created.technical.lastError}` : "."
          } Retry it from the shipment page.`,
        );
      } else {
        toast.success(`Shipment ${created.shipmentNumber} created.`);
      }
      onCreated(created);
    } catch (error) {
      setServerError({
        message: problem(error, "The shipment wasn't created. Please try again."),
        code: error instanceof ApiError ? error.code : "",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onOpenChange={(open) => !open && !submitting && onClose()} title={`Create shipment for #${shipping.order.orderNumber}`} className="max-w-2xl">
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {serverError ? (
          <div role="alert" className="flex items-start gap-2 rounded-[3px] bg-[#fbeaea] px-3 py-2.5 text-xs text-[#a12b2b]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>
              {serverError.message}
              {serverError.code === "SHIPMENT_EXISTS" ? " Close this and open the existing shipment instead." : ""}
            </span>
          </div>
        ) : null}

        {providers.length === 0 ? (
          <p className="text-xs text-admin-muted">No courier is switched on. Set one up in Courier settings first.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {/* The provider is chosen by its courier code (docs/id-lookup.md); the default is preselected. */}
            <div className="flex flex-col gap-1.5">
              <IdSelector
                entity="courier"
                label="Courier provider — Courier code"
                required
                compact
                disabled={submitting}
                value={providerCode || null}
                onChange={(code) => switchProvider(code ?? "")}
              />
              {provider ? (
                <p className="text-[0.6875rem] text-admin-muted">
                  {provider.name}{provider.isDefault ? " (default)" : ""}
                </p>
              ) : providerCode ? (
                <p role="alert" className="text-[0.6875rem] text-[#c23434]">
                  Courier {providerCode} isn&rsquo;t switched on for shipments. Choose another, or enable it in Courier settings.
                </p>
              ) : null}
            </div>
            {provider && provider.services.length > 0 ? (
              <AdminSelect
                label="Service"
                required
                placeholder="Choose a service"
                value={service}
                error={errors.service}
                disabled={submitting}
                onChange={(event) => {
                  setService(event.target.value);
                  setErrors((current) => ({ ...current, service: undefined }));
                }}
                options={provider.services.map((value) => ({ value, label: value }))}
              />
            ) : null}
            {isManual ? (
              <>
                <AdminInput
                  label="Courier name"
                  required
                  value={courierName}
                  error={errors.courierName}
                  disabled={submitting}
                  placeholder="e.g. DTDC"
                  onChange={(event) => setCourierName(event.target.value)}
                />
                <AdminInput
                  label="AWB / tracking number"
                  required
                  value={awb}
                  error={errors.awb}
                  disabled={submitting}
                  onChange={(event) => setAwb(event.target.value)}
                />
              </>
            ) : null}
          </div>
        )}

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-admin-ink">Package</legend>
          <p className="mb-3 text-[0.6875rem] text-admin-muted">
            {isManual ? "Only the weight is needed for a manual courier." : "The courier needs the weight, all three dimensions, the count and the type."}
            {packed
              ? " Prefilled from the packed parcels."
              : shipping.defaultPackage ? " Prefilled from the courier's saved default package." : ""}
          </p>
          <PackageFields form={pkg} errors={errors} requireAll={!isManual} disabled={submitting} onChange={updatePackage} />
        </fieldset>

        {provider?.supports.rates ? (
          <section aria-label="Courier rates" className="rounded-[3px] border border-admin-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-admin-muted">
                {courier ? (
                  <>
                    Courier: <strong className="text-admin-ink">{courier.courierName}</strong>
                  </>
                ) : (
                  "Optional: compare couriers, or leave it to the provider to assign one."
                )}
              </p>
              <AdminButton size="sm" loading={loadingRates} disabled={submitting} onClick={() => void fetchRates()}>
                Get rates
              </AdminButton>
            </div>
            {ratesError ? (
              <p role="alert" className="mt-2 text-[0.6875rem] text-[#a12b2b]">
                {ratesError}
              </p>
            ) : null}
            {rates !== null ? (
              rates.length === 0 ? (
                <p className="mt-2 text-xs text-admin-muted">No courier serves this route for that package.</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-1.5" role="radiogroup" aria-label="Choose a courier">
                  {rates.map((option) => {
                    const chosen = courier?.courierCode === option.courierCode;
                    return (
                      <li key={option.courierCode}>
                        <label
                          className={cn(
                            "flex cursor-pointer items-center justify-between gap-3 rounded-[3px] border px-3 py-2 text-xs",
                            chosen ? "border-copper-500 bg-admin-raised" : "border-admin-border hover:bg-admin-raised",
                          )}
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="radio"
                              name="courier"
                              checked={chosen}
                              disabled={submitting}
                              onChange={() => setCourier(option)}
                              className="accent-copper-600"
                            />
                            <span>
                              <span className="block font-medium text-admin-ink">{option.courierName}</span>
                              <span className="block text-[0.625rem] text-admin-muted">
                                {[
                                  formatEta(option.etaDays),
                                  option.estimatedDeliveryAt ? `by ${formatDate(option.estimatedDeliveryAt)}` : "",
                                  option.codAvailable ? "COD" : "No COD",
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            </span>
                          </span>
                          <span className="tabular-nums text-admin-ink">{formatPrice(option.rate)}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )
            ) : null}
          </section>
        ) : null}

        <div className="flex justify-end gap-2">
          <AdminButton variant="secondary" disabled={submitting} onClick={onClose}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={submitting} disabled={!provider}>
            Create shipment
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}
