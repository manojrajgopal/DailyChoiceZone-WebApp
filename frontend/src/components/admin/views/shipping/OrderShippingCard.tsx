"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, PackagePlus } from "lucide-react";

import { AdminButton, AdminButtonLink, AdminCard } from "@/components/admin/ui/AdminChrome";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { getOrderShipping } from "@/services/shippingService";
import type { Shipment } from "@/types/shipping";

import { CreateShipmentDialog } from "./CreateShipmentDialog";
import { ShipmentStatusBadge } from "./shared";

/**
 * The "Shipping" card on an order: its active shipment, or — when the order
 * is ready — a way to create one. Whether it can be created, and why not, is
 * the server's answer.
 */
export function OrderShippingCard({ orderId, onChanged }: { orderId: string; onChanged?: () => void }) {
  const shipping = useAdminResource(() => getOrderShipping(orderId), [orderId]);
  const [creating, setCreating] = useState(false);

  // Without the shipments permission there is nothing to show here.
  if (shipping.error instanceof ApiError && shipping.error.status === 403) return null;

  const data = shipping.data;
  const active = data?.shipments.find((entry) => entry.id === data.activeShipmentId) ?? null;
  const past = data?.shipments.filter((entry) => entry.id !== data.activeShipmentId) ?? [];

  const created = (shipment: Shipment) => {
    setCreating(false);
    void shipping.reload();
    onChanged?.();
    return shipment;
  };

  return (
    <AdminCard title="Shipping">
      {shipping.isLoading && !data ? (
        <div className="flex flex-col gap-2" aria-label="Loading shipping">
          <span className="block h-3 w-2/3 animate-pulse rounded-[2px] bg-admin-border" />
          <span className="block h-3 w-1/2 animate-pulse rounded-[2px] bg-admin-border" />
        </div>
      ) : !data ? (
        <div className="text-xs">
          <p className="text-admin-ink">Shipping details didn&rsquo;t load.</p>
          <AdminButton size="sm" className="mt-2" onClick={() => void shipping.reload()}>
            Try again
          </AdminButton>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-xs">
          {active ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-admin-ink">{active.shipmentNumber}</span>
                <ShipmentStatusBadge status={active.status} label={active.statusLabel} />
              </div>
              <p className="text-admin-muted">
                {[active.courierName, active.awb ? `AWB ${active.awb}` : "AWB pending"].filter(Boolean).join(" · ")}
              </p>
              {active.expectedDeliveryAt ? <p className="text-admin-muted">Expected {formatDate(active.expectedDeliveryAt)}</p> : null}
              {active.requestStatus === "failed" ? (
                <p className="flex items-start gap-1 text-[#a12b2b]">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                  Courier request failed{active.lastError ? `: ${active.lastError}` : ""}
                </p>
              ) : null}
              <AdminButtonLink href={`/admin/shipments/detail?id=${active.id}`} size="sm" className="mt-1 self-start">
                Open shipment
              </AdminButtonLink>
            </div>
          ) : data.canCreate ? (
            <div>
              <p className="mb-3 leading-relaxed text-admin-muted">Not shipped yet. Book a courier once the parcel is packed.</p>
              <AdminButton variant="primary" size="sm" onClick={() => setCreating(true)}>
                <PackagePlus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Create shipment
              </AdminButton>
            </div>
          ) : (
            <p className="leading-relaxed text-admin-muted">{data.reason || "A shipment can't be created for this order right now."}</p>
          )}

          {past.length > 0 ? (
            <div className="border-t border-admin-border pt-3">
              <p className="mb-1.5 text-[0.6875rem] font-medium text-admin-muted">Earlier shipments</p>
              <ul className="flex flex-col gap-1">
                {past.map((entry) => (
                  <li key={entry.id} className="flex items-center justify-between gap-2">
                    <Link href={`/admin/shipments/detail?id=${entry.id}`} className="text-admin-ink hover:text-copper-700">
                      {entry.shipmentNumber}
                    </Link>
                    <ShipmentStatusBadge status={entry.status} label={entry.statusLabel} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}

      {creating && data ? (
        <CreateShipmentDialog orderId={orderId} shipping={data} onClose={() => setCreating(false)} onCreated={created} />
      ) : null}
    </AdminCard>
  );
}
