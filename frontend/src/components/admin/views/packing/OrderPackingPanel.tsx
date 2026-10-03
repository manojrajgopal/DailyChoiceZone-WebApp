"use client";

import Link from "next/link";

import { AdminCard } from "@/components/admin/ui/AdminChrome";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate } from "@/lib/utils/format";
import { getOrderPacking } from "@/services/admin/packingAdminService";

import { PackingStatusBadge, PriorityBadge } from "./shared";

/**
 * Where the order is in picking and packing, with a way into the packing
 * workspace. Orders appear there once confirmed; this card only reads.
 */
export function OrderPackingPanel({ orderId }: { orderId: string }) {
  const packing = useAdminResource(() => getOrderPacking(orderId), [orderId]);
  // Staff without the packing permission get a 403: the card just isn't shown.
  if (packing.error || !packing.data) return null;
  const job = packing.data.job;

  return (
    <AdminCard
      title="Packing"
      action={job ? (
        <Link href={`/admin/packing/job?id=${job.id}`} className="text-xs font-medium text-copper-700 hover:text-admin-ink">
          Open packing
        </Link>
      ) : null}
    >
      {job ? (
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <PackingStatusBadge status={job.status} label={job.statusLabel} />
            <PriorityBadge priority={job.priority} />
          </div>
          <p className="text-admin-muted">
            {job.packageCount} package{job.packageCount === 1 ? "" : "s"}
            {job.packedAt ? ` · packed ${formatDate(job.packedAt)}` : ""}
            {job.assignedTo ? ` · ${job.assignedTo}` : " · unassigned"}
          </p>
        </div>
      ) : (
        <p className="text-xs text-admin-muted">Not in the packing queue — it joins once the order is confirmed.</p>
      )}
    </AdminCard>
  );
}
