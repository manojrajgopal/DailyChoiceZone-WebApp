"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink, MapPin, Truck } from "lucide-react";

import { Skeleton } from "@/components/ui/Skeleton";
import { formatDateTime, toDate } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { getOrderShipments } from "@/services/shippingService";
import type { CustomerShipment, CustomerShipmentEvent } from "@/types/shipping";

function oldestFirst(events: readonly CustomerShipmentEvent[]): CustomerShipmentEvent[] {
  const time = (event: CustomerShipmentEvent) => toDate(event.occurredAt)?.getTime() ?? 0;
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => time(a.event) - time(b.event) || a.index - b.index)
    .map(({ event }) => event);
}

/**
 * The parcel on its way: courier, tracking number and — on request — every
 * step it has taken. Only what the customer is meant to see arrives here, and
 * only that is shown. Nothing is shown before an order has been handed to a
 * courier; the order tracker above already covers that.
 */
export function OrderShipments({ orderNumber }: { orderNumber: string }) {
  const [shipments, setShipments] = useState<CustomerShipment[] | null>(null);
  const [failed, setFailed] = useState(false);

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getOrderShipments(orderNumber)
      .then((result) => live && setShipments(result))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [orderNumber, attempt]);

  const retry = () => {
    setFailed(false);
    setShipments(null);
    setAttempt((value) => value + 1);
  };

  if (failed) {
    return (
      <section aria-labelledby="shipment-heading" className="rounded-card border border-ink-200 bg-shell p-5">
        <h2 id="shipment-heading" className="label-wide text-ink">
          Shipment
        </h2>
        <p className="mt-2 text-xs text-ink-500">
          Tracking details couldn&rsquo;t load just now.{" "}
          <button type="button" onClick={retry} className="font-medium text-copper-700 underline underline-offset-2 hover:text-ink">
            Try again
          </button>
        </p>
      </section>
    );
  }

  if (shipments === null) {
    return (
      <div role="status" aria-label="Loading shipment">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (shipments.length === 0) return null;

  // The live one first; cancelled ones stay listed so the history is honest.
  const ordered = [...shipments].sort((a, b) => Number(a.status === "cancelled") - Number(b.status === "cancelled"));

  return (
    <section aria-labelledby="shipment-heading" className="rounded-card border border-ink-200 bg-shell p-5">
      <h2 id="shipment-heading" className="label-wide text-ink">
        {ordered.length === 1 ? "Shipment" : "Shipments"}
      </h2>
      <ul className="mt-4 flex flex-col gap-5">
        {ordered.map((shipment) => (
          <ShipmentCard key={shipment.shipmentNumber} shipment={shipment} />
        ))}
      </ul>
    </section>
  );
}

function ShipmentCard({ shipment }: { shipment: CustomerShipment }) {
  const [open, setOpen] = useState(false);
  const events = oldestFirst(shipment.events);
  const latest = events.at(-1);
  const cancelled = shipment.status === "cancelled";
  const panelId = `shipment-events-${shipment.shipmentNumber}`;

  return (
    <li className={cn("flex flex-col gap-3", cancelled && "opacity-70")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Truck className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" strokeWidth={1.5} aria-hidden="true" />
          <div className="text-sm">
            <p className="font-medium text-ink">{shipment.statusLabel}</p>
            <p className="mt-0.5 text-xs text-ink-500">
              {[shipment.courierName, shipment.service].filter(Boolean).join(" · ") || "Courier"}
              {shipment.awb ? (
                <>
                  {" · Tracking number "}
                  <span className="font-mono text-ink-700">{shipment.awb}</span>
                </>
              ) : null}
            </p>
            {shipment.deliveredAt ? (
              <p className="mt-0.5 text-xs text-ink-500">Delivered {formatDate(shipment.deliveredAt)}</p>
            ) : shipment.expectedDeliveryAt && !cancelled ? (
              <p className="mt-0.5 text-xs text-ink-500">Expected by {formatDate(shipment.expectedDeliveryAt)}</p>
            ) : null}
          </div>
        </div>
        {shipment.trackingUrl ? (
          <a
            href={shipment.trackingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-copper-700 underline underline-offset-2 hover:text-ink"
          >
            Track on the courier&rsquo;s site
            <ExternalLink className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          </a>
        ) : null}
      </div>

      {events.length === 0 ? (
        <p className="pl-7 text-xs text-ink-400">
          {cancelled ? "This shipment was cancelled." : "Tracking updates will appear here once the courier picks it up."}
        </p>
      ) : (
        <div className="pl-7">
          {latest && !open ? (
            <p className="text-xs text-ink-500">
              Latest: {latest.label}
              {latest.location ? `, ${latest.location}` : ""} · {formatDateTime(latest.occurredAt)}
            </p>
          ) : null}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-copper-700 hover:text-ink"
          >
            {open ? "Hide tracking history" : `Show tracking history (${events.length})`}
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {open ? (
            <ol id={panelId} className="mt-3 flex flex-col gap-3 border-l border-ink-200 pl-4" aria-label="Tracking history">
              {events.map((event, index) => (
                <li key={`${event.occurredAt}-${index}`} className="relative text-xs">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute -left-[1.3rem] top-1 h-2 w-2 rounded-pill",
                      index === events.length - 1 ? "bg-sage-500" : "bg-ink-200",
                    )}
                  />
                  <p className="font-medium text-ink">{event.label}</p>
                  {event.description && event.description !== event.label ? <p className="mt-0.5 text-ink-500">{event.description}</p> : null}
                  {event.location ? (
                    <p className="mt-0.5 flex items-center gap-1 text-ink-500">
                      <MapPin className="h-3 w-3 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      {event.location}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[0.6875rem] text-ink-400">{formatDateTime(event.occurredAt)}</p>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}
    </li>
  );
}
