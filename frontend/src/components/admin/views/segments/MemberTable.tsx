"use client";

import Link from "next/link";

import { TD, TH, TableState } from "@/components/admin/views/operations/shared";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";
import type { SegmentMember } from "@/types/segments";

import { RFM_LABELS, rupees } from "./shared";

/**
 * Customers in a segment (or a preview of one). Email and phone arrive masked
 * unless the admin may export, and are shown exactly as sent.
 */
export function MemberTable({
  members,
  loading,
  failed,
  onRetry,
  emptyTitle,
  emptyHint,
  refreshing = false,
  label,
}: {
  members: SegmentMember[] | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  emptyTitle: string;
  emptyHint: string;
  refreshing?: boolean;
  label: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className={cn("w-full min-w-[46rem] text-left text-xs", refreshing && "opacity-60")}>
        <thead className="border-b border-admin-border bg-admin-raised text-admin-muted">
          <tr>
            <th className={TH}>Customer</th>
            <th className={TH}>Location</th>
            <th className={cn(TH, "text-right")}>Orders</th>
            <th className={cn(TH, "text-right")}>Spend</th>
            <th className={TH}>Last order</th>
            <th className={TH}>RFM</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-admin-border">
          <TableState
            columns={6}
            loading={loading}
            failed={failed}
            empty={Boolean(members && members.length === 0)}
            onRetry={onRetry}
            title={emptyTitle}
            hint={emptyHint}
          />
          {members?.map((member) => (
            <tr key={member.customerId} className="align-top hover:bg-admin-raised">
              <td className={TD}>
                <Link
                  href={`/admin/customers/detail?id=${encodeURIComponent(member.customerId)}`}
                  className="block font-medium text-admin-ink hover:text-copper-700"
                >
                  {member.name || member.customerId}
                </Link>
                <span className="block text-admin-muted">{[member.email, member.phone].filter(Boolean).join(" · ")}</span>
              </td>
              <td className={cn(TD, "text-admin-muted")}>{[member.city, member.state].filter(Boolean).join(", ") || "—"}</td>
              <td className={cn(TD, "text-right tabular-nums")}>{member.totalOrders.toLocaleString("en-IN")}</td>
              <td className={cn(TD, "text-right tabular-nums")}>{rupees(member.totalSpend)}</td>
              <td className={cn(TD, "whitespace-nowrap text-admin-muted")}>
                {member.lastOrderAt ? formatDate(member.lastOrderAt) : "Never"}
              </td>
              <td className={TD}>
                <span className="block text-admin-ink">{RFM_LABELS[member.rfmLabel] ?? member.rfmLabel}</span>
                {member.rfmScore && member.rfmScore !== "000" ? (
                  <span className="block font-mono text-[0.6875rem] text-admin-muted">{member.rfmScore}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
