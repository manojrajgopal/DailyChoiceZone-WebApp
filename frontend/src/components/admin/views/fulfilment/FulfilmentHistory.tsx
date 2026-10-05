"use client";

import Link from "next/link";
import { useState } from "react";

import { AdminCard } from "@/components/admin/ui/AdminChrome";
import { cn } from "@/lib/utils/cn";
import { formatDateTime } from "@/lib/utils/format";
import type { FulfilmentHistoryEntry } from "@/types/fulfilment";

/**
 * Every status change on the order, its packing job and its shipments, in
 * one append-only history: when, what, who, why. Newest first. Nothing here
 * is derived from the current status; each line is a stored event.
 */

const KIND_DOT: Record<FulfilmentHistoryEntry["kind"], string> = {
  order: "bg-copper-500",
  packing: "bg-[#2a78d6]",
  shipment: "bg-[#0ca30c]",
};
const KIND_LABEL: Record<FulfilmentHistoryEntry["kind"], string> = {
  order: "Order",
  packing: "Packing",
  shipment: "Shipment",
};
const FILTERS = [
  { value: "", label: "All" },
  { value: "order", label: "Order" },
  { value: "packing", label: "Packing" },
  { value: "shipment", label: "Shipment" },
] as const;

function entityLink(entry: FulfilmentHistoryEntry): { href: string; label: string } | null {
  if (!entry.entity) return null;
  if (entry.entity.type === "packing") return { href: `/admin/packing/job?id=${entry.entity.id}`, label: `Packing job #${entry.entity.id}` };
  if (entry.entity.type === "shipment") {
    return entry.entity.shipmentId
      ? { href: `/admin/shipments/detail?id=${entry.entity.shipmentId}`, label: entry.entity.id }
      : { href: `/admin/shipments?q=${encodeURIComponent(entry.entity.id)}`, label: entry.entity.id };
  }
  return null;
}

export function FulfilmentHistory({ entries }: { entries: FulfilmentHistoryEntry[] }) {
  const [kind, setKind] = useState<string>("");
  const shown = [...entries].reverse().filter((entry) => !kind || entry.kind === kind);

  return (
    <AdminCard
      title="History"
      description="Every change to this order, its packing and its shipments."
      action={
        <div role="group" aria-label="Show history for" className="flex gap-1">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={kind === filter.value}
              onClick={() => setKind(filter.value)}
              className={cn(
                "rounded-[2px] px-1.5 py-0.5 text-[0.625rem] font-medium",
                kind === filter.value ? "bg-admin-ink text-white" : "text-admin-muted hover:text-admin-ink",
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      }
    >
      {shown.length === 0 ? (
        <p className="text-xs text-admin-muted">Nothing recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {shown.map((entry, index) => {
            const link = entityLink(entry);
            return (
              <li key={`${entry.kind}-${entry.at}-${index}`} className="flex gap-2.5">
                <span aria-hidden="true" className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill", KIND_DOT[entry.kind])} />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-admin-ink">
                    {entry.title}
                    <span className="ml-1.5 text-[0.5625rem] font-medium uppercase tracking-[0.06em] text-admin-faint">
                      {KIND_LABEL[entry.kind]}
                    </span>
                  </span>
                  <span className="block text-[0.625rem] text-admin-muted">
                    {formatDateTime(entry.at)} · by {entry.actorName}
                    {entry.location ? ` · ${entry.location}` : ""}
                    {link ? (
                      <>
                        {" · "}
                        <Link href={link.href} className="text-copper-700 hover:text-admin-ink">
                          {link.label}
                        </Link>
                      </>
                    ) : null}
                  </span>
                  {entry.reason ? (
                    <span className="mt-0.5 block text-[0.6875rem] text-[#8a5d00]">Reason: {entry.reason}</span>
                  ) : null}
                  {entry.note && entry.note !== entry.reason ? (
                    <span className="mt-0.5 block text-[0.6875rem] italic text-admin-muted">{entry.note}</span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </AdminCard>
  );
}
