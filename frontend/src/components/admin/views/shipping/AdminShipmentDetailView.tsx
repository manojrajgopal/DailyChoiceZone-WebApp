"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2, RefreshCw, RotateCcw, Tag, Truck, X } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard, AdminPageHeader, ConfirmDialog } from "@/components/admin/ui/AdminChrome";
import { AdminTextarea } from "@/components/admin/ui/AdminForm";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { Detail, problem } from "@/components/admin/views/operations/shared";
import { Modal } from "@/components/ui/Dialog";
import { formatDateTime } from "@/lib/support/format";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { paymentMethodLabel } from "@/services/billing/paymentService";
import {
  cancelShipment,
  generateLabel,
  getShipment,
  refreshShipment,
  retryShipment,
  schedulePickup,
  updateShipmentPackage,
} from "@/services/shippingService";
import { toast } from "@/store/toastStore";
import type { Shipment } from "@/types/shipping";

import { ManualEventDialog } from "./ManualEventDialog";
import { TrackingTimeline } from "./TrackingTimeline";
import { PackageFields, addressLines, packageForm, validatePackage, ShipmentStatusBadge, type PackageErrors } from "./shared";

type Load =
  | { state: "loading" }
  | { state: "missing" }
  | { state: "error"; message: string }
  | { state: "ready"; shipment: Shipment };

type Busy = "refresh" | "retry" | "label" | "pickup" | "cancel" | null;

const REQUEST: Record<string, { label: string; tone: "good" | "warning" | "critical" }> = {
  ok: { label: "Confirmed by the courier", tone: "good" },
  pending: { label: "Waiting for the courier", tone: "warning" },
  failed: { label: "Courier request failed", tone: "critical" },
};

function packageSummary(pkg: Shipment["package"]): string {
  const dims = [pkg.lengthCm, pkg.widthCm, pkg.heightCm].every((value) => value !== null && value !== undefined)
    ? `${pkg.lengthCm} × ${pkg.widthCm} × ${pkg.heightCm} cm`
    : "";
  return [
    pkg.weightGrams !== null && pkg.weightGrams !== undefined ? `${pkg.weightGrams.toLocaleString("en-IN")} g` : "",
    dims,
    pkg.count ? `${pkg.count} ${pkg.count === 1 ? "package" : "packages"}` : "",
    pkg.type ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One shipment: the order it carries, where it's going, its tracking history
 * and the courier's technical state. Which actions are offered is the
 * server's decision (`actions`), never worked out here.
 */
export function AdminShipmentDetailView() {
  const searchParams = useSearchParams();
  const id = searchParams?.get("id") ?? "";
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [busy, setBusy] = useState<Busy>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelError, setCancelError] = useState("");
  const [eventOpen, setEventOpen] = useState(false);
  const [eventKey, setEventKey] = useState(0);
  const [packageOpen, setPackageOpen] = useState(false);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!id) return;
    let live = true;
    getShipment(id)
      .then((shipment) => live && setLoad({ state: "ready", shipment }))
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) setLoad({ state: "missing" });
        else setLoad({ state: "error", message: problem(error, "This shipment didn't load.") });
      });
    return () => {
      live = false;
    };
  }, [id, attempt]);

  /** Read it again; `quiet` keeps what's on screen until the answer arrives. */
  const fetchShipment = (quiet = false) => {
    if (!quiet) setLoad({ state: "loading" });
    setAttempt((value) => value + 1);
  };

  const crumbs = [
    { label: "Admin", href: "/admin/dashboard" },
    { label: "Shipments", href: "/admin/shipments" },
  ];

  const view: Load = id ? load : { state: "missing" };

  if (view.state === "loading") {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading shipment" />
      </div>
    );
  }

  if (view.state === "missing" || view.state === "error") {
    return (
      <div>
        <AdminPageHeader title={view.state === "missing" ? "Shipment not found" : "Shipment didn't load"} breadcrumbs={crumbs} />
        <div className="rounded-[3px] border border-admin-border bg-admin-surface p-8 text-center">
          <p className="text-sm text-admin-ink">
            {view.state === "missing" ? "We couldn’t find this shipment." : view.message}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            {view.state === "error" ? (
              <AdminButton variant="primary" onClick={() => fetchShipment()}>
                Try again
              </AdminButton>
            ) : null}
            <AdminButtonLink href="/admin/shipments">Back to shipments</AdminButtonLink>
          </div>
        </div>
      </div>
    );
  }

  const shipment = view.shipment;
  const { actions, technical, order } = shipment;
  const setShipment = (next: Shipment) => setLoad({ state: "ready", shipment: next });

  const run = async (kind: Exclude<Busy, null | "cancel">) => {
    setBusy(kind);
    try {
      if (kind === "refresh") {
        setShipment(await refreshShipment(shipment.id));
        toast.success("Tracking updated.");
      } else if (kind === "retry") {
        const next = await retryShipment(shipment.id);
        setShipment(next);
        if (next.technical.requestStatus === "failed") {
          toast.error(`The courier still didn't accept it${next.technical.lastError ? `: ${next.technical.lastError}` : "."}`);
        } else toast.success("Sent to the courier again.");
      } else if (kind === "label") {
        const next = await generateLabel(shipment.id);
        setShipment(next);
        toast.success(next.label.url ? "Label ready to download." : "Label requested.");
      } else {
        const next = await schedulePickup(shipment.id);
        setShipment(next);
        if (next.pickup.status === "failed") toast.error("The courier couldn't schedule a pickup.");
        else toast.success("Pickup scheduled.");
      }
    } catch (error) {
      toast.error(problem(error, "That didn't work. Please try again."));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    const reason = cancelReason.trim();
    if (reason.length < 3) {
      setCancelError("Say why it's being cancelled.");
      return;
    }
    setBusy("cancel");
    try {
      setShipment(await cancelShipment(shipment.id, reason));
      toast.success("Shipment cancelled.");
      setCancelOpen(false);
      setCancelReason("");
    } catch (error) {
      toast.error(problem(error, "The shipment wasn't cancelled. Please try again."));
      if (error instanceof ApiError && error.code === "SHIPMENT_NOT_CANCELLABLE") {
        setCancelOpen(false);
        fetchShipment(true);
      }
    } finally {
      setBusy(null);
    }
  };

  const request = REQUEST[technical.requestStatus] ?? REQUEST.pending!;
  const disabled = busy !== null;

  return (
    <div>
      <AdminPageHeader
        title={`Shipment ${shipment.shipmentNumber}`}
        description={`Order #${order.orderNumber} · ${order.customer.name} · created ${formatDate(shipment.createdAt)}`}
        breadcrumbs={[...crumbs, { label: shipment.shipmentNumber }]}
        actions={<ShipmentStatusBadge status={shipment.status} label={shipment.statusLabel} />}
      />

      {technical.requestStatus === "failed" ? (
        <div role="alert" className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-[3px] border border-[#f1c4c4] bg-[#fbeaea] px-4 py-3">
          <p className="flex items-start gap-2 text-xs text-[#a12b2b]">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>
              <span className="block font-medium">The courier didn&rsquo;t accept the last request ({technical.lastOperation || "create"}).</span>
              {technical.lastError ? <span className="mt-0.5 block">{technical.lastError}</span> : null}
              {technical.nextRetryAt ? <span className="mt-0.5 block">Retrying automatically {formatDateTime(technical.nextRetryAt)}.</span> : null}
            </span>
          </p>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2" aria-label="Shipment actions" role="group">
        {actions.refresh ? (
          <AdminButton size="sm" loading={busy === "refresh"} disabled={disabled} onClick={() => void run("refresh")}>
            {busy === "refresh" ? null : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Refresh tracking
          </AdminButton>
        ) : null}
        {actions.retry ? (
          <AdminButton size="sm" variant="primary" loading={busy === "retry"} disabled={disabled} onClick={() => void run("retry")}>
            {busy === "retry" ? null : <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Retry
          </AdminButton>
        ) : null}
        {actions.label ? (
          <AdminButton size="sm" loading={busy === "label"} disabled={disabled} onClick={() => void run("label")}>
            {busy === "label" ? null : <Tag className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            {shipment.label.available ? "Regenerate label" : "Generate label"}
          </AdminButton>
        ) : null}
        {actions.pickup ? (
          <AdminButton size="sm" loading={busy === "pickup"} disabled={disabled} onClick={() => void run("pickup")}>
            {busy === "pickup" ? null : <Truck className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
            Schedule pickup
          </AdminButton>
        ) : null}
        {actions.manualEvent ? (
          <AdminButton
            size="sm"
            disabled={disabled}
            onClick={() => {
              setEventKey((key) => key + 1);
              setEventOpen(true);
            }}
          >
            Record event
          </AdminButton>
        ) : null}
        {actions.editPackage ? (
          <AdminButton size="sm" disabled={disabled} onClick={() => setPackageOpen(true)}>
            Edit package
          </AdminButton>
        ) : null}
        {actions.cancel ? (
          <AdminButton
            size="sm"
            variant="danger"
            disabled={disabled}
            onClick={() => {
              setCancelError("");
              setCancelOpen(true);
            }}
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Cancel shipment
          </AdminButton>
        ) : null}
        {shipment.label.available && shipment.label.url ? (
          <a
            href={shipment.label.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-[3px] px-3 text-xs font-medium text-copper-700 hover:bg-admin-raised"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            Download label
          </a>
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-4">
          <AdminCard title="Tracking" description="Every update, oldest first.">
            <TrackingTimeline events={shipment.events} />
          </AdminCard>

          <AdminCard title="Shipping">
            <dl className="grid gap-3 text-xs sm:grid-cols-2">
              <Detail label="Provider">{shipment.provider.name}</Detail>
              <Detail label="Courier">{shipment.courierName || "—"}</Detail>
              <Detail label="Service">{shipment.service || "—"}</Detail>
              <Detail label="AWB">{shipment.awb ? <span className="font-mono">{shipment.awb}</span> : "Not assigned yet"}</Detail>
              <Detail label="Expected delivery">{shipment.expectedDeliveryAt ? formatDate(shipment.expectedDeliveryAt) : "—"}</Detail>
              <Detail label="Delivered">{shipment.deliveredAt ? formatDateTime(shipment.deliveredAt) : "—"}</Detail>
              <Detail label="Package" wide>
                {packageSummary(shipment.package) || "—"}
              </Detail>
              <Detail label="Cash on delivery">{shipment.cod ? `Collect ${formatPrice(shipment.codAmount)}` : "No"}</Detail>
              <Detail label="Declared value">{formatPrice(shipment.declaredValue)}</Detail>
              <Detail label="Pickup">
                {shipment.pickup.status === "scheduled"
                  ? `Scheduled${shipment.pickup.scheduledAt ? ` for ${formatDateTime(shipment.pickup.scheduledAt)}` : ""}${shipment.pickup.token ? ` · token ${shipment.pickup.token}` : ""}`
                  : shipment.pickup.status === "failed"
                    ? "Couldn't be scheduled"
                    : "Not scheduled"}
              </Detail>
              <Detail label="Label">{shipment.label.available ? "Ready" : "Not generated"}</Detail>
              <Detail label="From">
                <AddressBlock lines={addressLines(shipment.origin)} />
              </Detail>
              <Detail label="To">
                <AddressBlock lines={addressLines(shipment.destination)} />
              </Detail>
            </dl>
          </AdminCard>
        </div>

        <div className="flex flex-col gap-4">
          <AdminCard
            title="Order"
            action={
              <Link href={`/admin/orders/detail?id=${encodeURIComponent(order.id)}`} className="text-xs font-medium text-copper-700 hover:text-admin-ink">
                Open order #{order.orderNumber}
              </Link>
            }
          >
            <div className="mb-3 flex flex-wrap gap-1.5">
              <DomainStatus domain="order" status={order.status} />
              <DomainStatus domain="payment" status={order.paymentStatus} />
            </div>
            <dl className="grid gap-2 text-xs">
              <Detail label="Customer">
                <span className="block">{order.customer.name}</span>
                {order.customer.email ? <span className="block text-admin-muted">{order.customer.email}</span> : null}
                {order.customer.phone ? <span className="block text-admin-muted">{order.customer.phone}</span> : null}
              </Detail>
              <Detail label="Payment">
                {paymentMethodLabel(order.paymentMethod)} · {formatPrice(order.total)}
              </Detail>
              <Detail label="Placed">{formatDate(order.placedAt)}</Detail>
            </dl>
            <ul className="mt-3 flex flex-col divide-y divide-admin-border border-t border-admin-border">
              {order.items.map((item, index) => (
                <li key={`${item.productId}-${index}`} className="flex items-start justify-between gap-3 py-2 text-xs">
                  <span className="min-w-0">
                    <span className="block font-medium text-admin-ink">{item.name}</span>
                    <span className="block text-[0.625rem] text-admin-muted">
                      {[item.sku, item.size, item.color].filter(Boolean).join(" · ")} · Qty {item.quantity}
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums text-admin-ink">{formatPrice(item.lineTotal)}</span>
                </li>
              ))}
            </ul>
          </AdminCard>

          <AdminCard title="Technical details" description="The courier connection, for when something needs a look.">
            <dl className="grid gap-2.5 text-xs" aria-label="Technical details">
              <Detail label="Request">
                <span className={request.tone === "critical" ? "text-[#a12b2b]" : request.tone === "warning" ? "text-[#8a5d00]" : "text-[#0a6b0a]"}>
                  {request.label}
                </span>
              </Detail>
              <Detail label="Last operation">{technical.lastOperation || "—"}</Detail>
              {technical.lastError ? (
                <Detail label="Last error">
                  <span className="text-[#a12b2b]">{technical.lastError}</span>
                  {technical.lastErrorAt ? <span className="block text-admin-muted">{formatDateTime(technical.lastErrorAt)}</span> : null}
                </Detail>
              ) : null}
              <Detail label="Retries">{technical.retryCount}</Detail>
              {technical.nextRetryAt ? <Detail label="Next retry">{formatDateTime(technical.nextRetryAt)}</Detail> : null}
              <Detail label="Last tracking check">{technical.lastSyncedAt ? formatDateTime(technical.lastSyncedAt) : "Never"}</Detail>
              <Detail label="Last webhook">{technical.lastWebhookAt ? formatDateTime(technical.lastWebhookAt) : "Never"}</Detail>
              <Detail label="Courier order ID">{shipment.providerOrderId || "—"}</Detail>
              <Detail label="Courier shipment ID">{shipment.providerShipmentId || "—"}</Detail>
              <Detail label="Courier code">{shipment.courierCode || "—"}</Detail>
              <Detail label="Created">
                {formatDateTime(shipment.createdAt)}
                {shipment.createdBy ? ` · ${shipment.createdBy}` : ""}
              </Detail>
              <Detail label="Updated">{formatDateTime(shipment.updatedAt)}</Detail>
            </dl>
          </AdminCard>
        </div>
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={(open) => busy !== "cancel" && setCancelOpen(open)}
        title="Cancel this shipment?"
        confirmLabel="Cancel shipment"
        loading={busy === "cancel"}
        onConfirm={() => void cancel()}
        message={
          <div className="flex flex-col gap-3">
            <p>
              {shipment.provider.name} is told to cancel {shipment.awb ? `AWB ${shipment.awb}` : "the booking"}. The order stays as it is, and a new
              shipment can be created afterwards.
            </p>
            <AdminTextarea
              label="Reason"
              required
              rows={2}
              value={cancelReason}
              error={cancelError || undefined}
              onChange={(event) => {
                setCancelReason(event.target.value);
                setCancelError("");
              }}
            />
          </div>
        }
      />

      {eventOpen ? (
        <ManualEventDialog key={eventKey} shipment={shipment} open={eventOpen} onOpenChange={setEventOpen} onSaved={setShipment} />
      ) : null}

      {packageOpen ? (
        <EditPackageDialog shipment={shipment} onClose={() => setPackageOpen(false)} onSaved={setShipment} />
      ) : null}
    </div>
  );
}

function AddressBlock({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <>—</>;
  return (
    <address className="not-italic leading-relaxed">
      {lines.map((line, index) => (
        <span key={index} className="block">
          {line}
        </span>
      ))}
    </address>
  );
}

/** Correct the package before the courier has confirmed the shipment. */
function EditPackageDialog({
  shipment,
  onClose,
  onSaved,
}: {
  shipment: Shipment;
  onClose: () => void;
  onSaved: (shipment: Shipment) => void;
}) {
  const [form, setForm] = useState(() => packageForm(shipment.package));
  const [errors, setErrors] = useState<PackageErrors>({});
  const [saving, setSaving] = useState(false);
  const requireAll = shipment.provider.code !== "manual";

  const save = async () => {
    const result = validatePackage(form, { requireAll });
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    setSaving(true);
    try {
      onSaved(await updateShipmentPackage(shipment.id, result.value));
      toast.success("Package updated.");
      onClose();
    } catch (error) {
      toast.error(problem(error, "The package wasn't updated. Please try again."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onOpenChange={(open) => !open && !saving && onClose()} title="Edit package" className="max-w-xl">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <PackageFields form={form} errors={errors} requireAll={requireAll} disabled={saving} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} />
        <div className="mt-5 flex justify-end gap-2">
          <AdminButton variant="secondary" disabled={saving} onClick={onClose}>
            Cancel
          </AdminButton>
          <AdminButton type="submit" variant="primary" loading={saving}>
            Save package
          </AdminButton>
        </div>
      </form>
    </Modal>
  );
}
