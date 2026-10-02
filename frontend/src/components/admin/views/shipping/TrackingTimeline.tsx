"use client";

import { EyeOff, MapPin } from "lucide-react";

import { humanStatus } from "@/components/admin/ui/StatusBadge";
import { formatDateTime, toDate } from "@/lib/support/format";
import { cn } from "@/lib/utils/cn";
import type { ShipmentEvent } from "@/types/shipping";

const SOURCE: Record<string, string> = {
  webhook: "Courier update",
  poll: "Tracking check",
  admin: "Recorded by staff",
  system: "Automatic",
};

/** Events in the order they happened, whatever order they arrived in. */
export function chronological<T extends { occurredAt: string }>(events: readonly T[]): T[] {
  const time = (event: T) => toDate(event.occurredAt)?.getTime() ?? 0;
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => time(a.event) - time(b.event) || a.index - b.index)
    .map(({ event }) => event);
}

/**
 * The admin's view of a shipment's history: every event, oldest first, with
 * where it came from and whether the customer can see it.
 */
export function TrackingTimeline({ events }: { events: readonly ShipmentEvent[] }) {
  if (events.length === 0) {
    return <p className="text-xs text-admin-muted">No tracking events yet. They appear here as the courier reports them.</p>;
  }
  const ordered = chronological(events);
  return (
    <ol className="flex flex-col gap-3" aria-label="Tracking events">
      {ordered.map((event, index) => {
        const latest = index === ordered.length - 1;
        const title = event.label || (event.status ? humanStatus(event.status) : event.providerStatus || "Update");
        return (
          <li key={`${event.id}-${index}`} className="flex gap-2.5">
            <span
              aria-hidden="true"
              className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill", latest ? "bg-copper-500" : "bg-admin-border-strong")}
            />
            <span className="min-w-0 text-xs">
              <span className="block font-medium text-admin-ink">{title}</span>
              {event.description ? <span className="mt-0.5 block text-admin-muted">{event.description}</span> : null}
              {event.location ? (
                <span className="mt-0.5 flex items-center gap-1 text-admin-muted">
                  <MapPin className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                  {event.location}
                </span>
              ) : null}
              <span className="mt-0.5 block text-[0.625rem] text-admin-faint">
                {formatDateTime(event.occurredAt)} · {SOURCE[event.source] ?? event.source}
                {event.actor ? ` · ${event.actor}` : ""}
                {event.providerStatus && event.providerStatus !== title ? ` · “${event.providerStatus}”` : ""}
              </span>
              {!event.visible ? (
                <span className="mt-0.5 inline-flex items-center gap-1 text-[0.625rem] text-admin-muted">
                  <EyeOff className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                  Hidden from the customer
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
