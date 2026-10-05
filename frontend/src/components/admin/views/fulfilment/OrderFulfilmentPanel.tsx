"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, ArrowRight, Box, Lock, PackageCheck, RotateCcw, Truck } from "lucide-react";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { problem } from "@/components/admin/views/operations/shared";
import { PackingStatusBadge } from "@/components/admin/views/packing/shared";
import { CreateShipmentDialog } from "@/components/admin/views/shipping/CreateShipmentDialog";
import { ShipmentStatusBadge } from "@/components/admin/views/shipping/shared";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { performAction } from "@/services/admin/fulfilmentAdminService";
import { getOrderShipping } from "@/services/shippingService";
import { toast } from "@/store/toastStore";
import type { FulfilmentAction, OrderFulfilment } from "@/types/fulfilment";
import type { OrderShipping } from "@/types/shipping";

import { FulfilmentProgress } from "./FulfilmentProgress";
import { ActionDialog } from "./ActionDialog";

/**
 * The order's place in fulfilment and what can be done next.
 *
 * There is no status dropdown. The server returns the valid next actions for
 * the order's current state and this admin's permissions; each is drawn as a
 * button (disabled with the reason when it can't be taken yet), confirmed in
 * a dialog, sent, and then everything is read again from the server. A move
 * is never assumed to have worked.
 */
export function OrderFulfilmentPanel({
  orderId,
  data,
  loading,
  failed,
  onRetry,
  onChanged,
}: {
  orderId: string;
  data: OrderFulfilment | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<FulfilmentAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [shipping, setShipping] = useState<OrderShipping | null>(null);
  const [openingShipment, setOpeningShipment] = useState(false);

  if (loading && !data) {
    return (
      <AdminCard title="Fulfilment" className="mb-4">
        <div className="flex flex-col gap-2" aria-label="Loading fulfilment">
          <span className="block h-6 w-full animate-pulse rounded-[2px] bg-admin-border" />
          <span className="block h-3 w-1/2 animate-pulse rounded-[2px] bg-admin-border" />
        </div>
      </AdminCard>
    );
  }
  if (!data) {
    return (
      <AdminCard title="Fulfilment" className="mb-4">
        <p className="text-xs text-admin-ink">{failed ? "The fulfilment details didn’t load." : "Nothing to show."}</p>
        <AdminButton size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </AdminButton>
      </AdminCard>
    );
  }

  const actions = data.nextActions;
  const primary = actions.find((action) => action.primary) ?? null;
  const others = actions.filter((action) => action !== primary);

  const start = async (action: FulfilmentAction) => {
    if (!action.allowed) return;
    if (action.kind === "link" && action.href) {
      router.push(action.href);
      return;
    }
    if (action.kind === "create-shipment") {
      setOpeningShipment(true);
      try {
        setShipping(await getOrderShipping(orderId));
      } catch (caught) {
        toast.error(problem(caught, "Shipping options didn’t load. Please try again."));
      } finally {
        setOpeningShipment(false);
      }
      return;
    }
    setError("");
    setPending(action);
  };

  const confirm = async (reason: string) => {
    if (!pending) return;
    setSaving(true);
    setError("");
    try {
      await performAction(orderId, pending, reason);
      toast.success(`${pending.label}: done.`);
      setPending(null);
      await onChanged();
    } catch (caught) {
      // The server's own business message: "Order cannot be packed because payment is pending."
      setError(problem(caught, "That step couldn’t be completed. Please try again."));
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const current = data.order;
  const exception = data.progress.exception;

  return (
    <AdminCard
      title="Fulfilment"
      description="Order → packing → shipment → delivery. Each step unlocks the next."
      className="mb-4"
      action={
        <span className="flex items-center gap-2">
          <span className="text-[0.6875rem] text-admin-muted">Order</span>
          <DomainStatus domain="order" status={current.status} label={current.statusLabel} />
        </span>
      }
    >
      <FulfilmentProgress progress={data.progress} />

      {data.warnings.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-2">
          {data.warnings.map((warning) => (
            <li
              key={warning.code}
              className="flex items-start gap-2 rounded-[3px] bg-[#fdf3dd] px-3 py-2 text-[0.6875rem] leading-relaxed text-[#8a5d00]"
            >
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              {warning.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 grid gap-4 border-t border-admin-border pt-4 lg:grid-cols-[1fr_1.4fr]">
        {/* ------------------------------------------------ next valid action */}
        <section aria-labelledby="next-step-heading">
          <h3 id="next-step-heading" className="text-xs font-semibold text-admin-ink">
            Next step
          </h3>
          {primary ? (
            <div className="mt-2 rounded-[3px] border border-admin-border bg-admin-raised p-3">
              <p className="text-[0.6875rem] leading-relaxed text-admin-muted">{primary.description}</p>
              <AdminButton
                variant={primary.destructive ? "danger" : "primary"}
                size="sm"
                className="mt-3"
                disabled={!primary.allowed}
                loading={openingShipment && primary.kind === "create-shipment"}
                onClick={() => void start(primary)}
              >
                {primary.allowed ? null : <Lock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />}
                {primary.label}
                {primary.allowed && primary.kind !== "create-shipment" ? (
                  <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                ) : null}
              </AdminButton>
              {!primary.allowed && primary.blockedReason ? (
                <p className="mt-2 text-[0.6875rem] leading-relaxed text-[#9c4a24]" role="note">
                  {primary.blockedReason}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-[0.6875rem] leading-relaxed text-admin-muted">
              {current.status === "delivered"
                ? "Delivered. Items coming back are handled as a return request."
                : current.status === "cancelled" || current.status === "returned"
                  ? `This order is ${current.statusLabel.toLowerCase()}. Nothing further can happen to it.`
                  : "Waiting on the courier: nothing to do here right now."}
            </p>
          )}

          {others.length > 0 ? (
            <div className="mt-3">
              <p className="text-[0.625rem] font-medium uppercase tracking-[0.06em] text-admin-faint">Other actions</p>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {others.map((action) => (
                  <li key={action.key}>
                    <button
                      type="button"
                      disabled={!action.allowed}
                      onClick={() => void start(action)}
                      title={action.allowed ? action.description : action.blockedReason}
                      className={cn(
                        "inline-flex items-center gap-1.5 text-[0.6875rem] font-medium",
                        action.allowed
                          ? action.destructive
                            ? "text-[#a12b2b] hover:underline"
                            : "text-copper-700 hover:text-admin-ink"
                          : "cursor-not-allowed text-admin-faint",
                      )}
                    >
                      {action.allowed ? null : <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />}
                      {action.label}
                      {action.requiresReason && action.allowed ? (
                        <span className="font-normal text-admin-faint">· needs a reason</span>
                      ) : null}
                    </button>
                    {!action.allowed && action.blockedReason ? (
                      <span className="block text-[0.625rem] leading-relaxed text-admin-faint">{action.blockedReason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {data.payment.blocked ? (
            <p className="mt-3 rounded-[3px] bg-[#fdeee7] px-2.5 py-2 text-[0.6875rem] text-[#9c4a24]">
              Payment: {data.payment.blocked}
            </p>
          ) : null}
        </section>

        {/* ------------------------------------------------- related records */}
        <section aria-labelledby="related-heading">
          <h3 id="related-heading" className="text-xs font-semibold text-admin-ink">
            Related records
          </h3>
          <dl className="mt-2 grid gap-2 text-[0.6875rem] sm:grid-cols-2">
            <Related icon={<Box className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} label="Packing">
              {data.packing ? (
                <>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <PackingStatusBadge status={data.packing.status as never} label={data.packing.statusLabel} />
                    <Link href={data.packing.href} className="font-medium text-copper-700 hover:text-admin-ink">
                      Job #{data.packing.id}
                    </Link>
                  </span>
                  <span className="mt-1 block text-admin-muted">
                    {data.packing.assignedTo ? `Assigned to ${data.packing.assignedTo}` : "Unassigned"}
                    {data.packing.packedAt ? ` · packed ${formatDate(data.packing.packedAt)}` : ""}
                    {data.packing.packedBy ? ` by ${data.packing.packedBy}` : ""}
                  </span>
                </>
              ) : (
                <span className="text-admin-muted">
                  {current.status === "pending" ? "Joins the packing queue once confirmed." : "No packing record."}
                </span>
              )}
            </Related>

            <Related icon={<PackageCheck className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} label="Packages">
              {data.packing && data.packing.packages.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {data.packing.packages.map((pkg) => (
                    <li key={pkg.packageNumber} className="text-admin-ink">
                      <span className="font-mono text-[0.625rem]">{pkg.packageNumber}</span>
                      <span className="block text-admin-muted">
                        {[pkg.type, pkg.weightGrams ? `${pkg.weightGrams} g` : null,
                          pkg.lengthCm && pkg.widthCm && pkg.heightCm ? `${pkg.lengthCm}×${pkg.widthCm}×${pkg.heightCm} cm` : null,
                          `${pkg.itemCount} item${pkg.itemCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-admin-muted">Not packed yet.</span>
              )}
            </Related>

            <Related icon={<Truck className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} label="Shipment & tracking">
              {data.shipment ? (
                <>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ShipmentStatusBadge status={data.shipment.status} label={data.shipment.statusLabel} />
                    <Link href={data.shipment.href} className="font-medium text-copper-700 hover:text-admin-ink">
                      {data.shipment.shipmentNumber}
                    </Link>
                  </span>
                  <span className="mt-1 block text-admin-muted">
                    {[data.shipment.courierName, data.shipment.awb ? `AWB ${data.shipment.awb}` : "AWB pending"]
                      .filter(Boolean).join(" · ")}
                  </span>
                  {data.shipment.expectedDeliveryAt ? (
                    <span className="block text-admin-muted">Expected {formatDate(data.shipment.expectedDeliveryAt)}</span>
                  ) : null}
                  {data.shipment.deliveryAttempts > 0 ? (
                    <span className={cn("block", exception ? "text-[#8a5d00]" : "text-admin-muted")}>
                      {data.shipment.deliveryAttempts} delivery attempt{data.shipment.deliveryAttempts === 1 ? "" : "s"}
                    </span>
                  ) : null}
                  {data.shipment.requestStatus === "failed" ? (
                    <span className="block text-[#a12b2b]">Courier request failed{data.shipment.lastError ? `: ${data.shipment.lastError}` : ""}</span>
                  ) : null}
                </>
              ) : (
                <span className="text-admin-muted">
                  {current.status === "packed" ? "Packed — ready for a shipment." : "Created once the order is packed."}
                </span>
              )}
            </Related>

            <Related icon={<RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />} label="Returns">
              {data.returns.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {data.returns.map((entry) => (
                    <li key={entry.id}>
                      <Link href={entry.href} className="font-medium text-copper-700 hover:text-admin-ink">
                        {entry.id}
                      </Link>{" "}
                      <span className="text-admin-muted">
                        {entry.kind} · {entry.statusLabel}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-admin-muted">
                  {current.status === "returned" ? "Returned to origin by the courier." : "None."}
                </span>
              )}
            </Related>
          </dl>
          {data.shipments.length > 1 ? (
            <p className="mt-2 text-[0.625rem] text-admin-muted">
              Earlier shipments:{" "}
              {data.shipments
                .filter((entry) => entry.id !== data.shipment?.id)
                .map((entry, index) => (
                  <span key={entry.id}>
                    {index > 0 ? ", " : ""}
                    <Link href={entry.href} className="text-copper-700 hover:text-admin-ink">
                      {entry.shipmentNumber}
                    </Link>{" "}
                    ({entry.statusLabel.toLowerCase()})
                  </span>
                ))}
            </p>
          ) : null}
        </section>
      </div>

      {pending ? (
      <ActionDialog
        open
        title={pending ? `${pending.label}?` : ""}
        description={pending?.description ?? ""}
        confirmLabel={pending?.label ?? "Confirm"}
        destructive={Boolean(pending?.destructive)}
        requiresReason={Boolean(pending?.requiresReason)}
        saving={saving}
        error={error}
        onCancel={() => setPending(null)}
        onConfirm={(reason) => void confirm(reason)}
      />
      ) : null}

      {shipping ? (
        <CreateShipmentDialog
          orderId={orderId}
          shipping={shipping}
          onClose={() => setShipping(null)}
          onCreated={(shipment) => {
            // The dialog announces the new shipment itself.
            setShipping(null);
            void onChanged();
            return shipment;
          }}
        />
      ) : null}
    </AdminCard>
  );
}

function Related({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[3px] border border-admin-border p-2.5">
      <dt className="mb-1 flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-[0.06em] text-admin-faint">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0 text-admin-ink">{children}</dd>
    </div>
  );
}
