"use client";

import { AlarmClock, Lock } from "lucide-react";

import type { SlaState, SupportMe, TicketPriority, TicketStatus } from "@/services/supportService";

import { AdminButtonLink, AdminCard } from "@/components/admin/ui/AdminChrome";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { PRIORITY_LABELS, PRIORITY_TONES, STATUS_TONES, formatDateTime, slaSummary } from "@/lib/support/format";
import { getSupportMe } from "@/services/supportService";

export function TicketStatusBadge({ status, label }: { status: TicketStatus; label: string }) {
  return <StatusBadge tone={STATUS_TONES[status] ?? "neutral"}>{label}</StatusBadge>;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return <StatusBadge tone={PRIORITY_TONES[priority] ?? "neutral"}>{PRIORITY_LABELS[priority] ?? priority}</StatusBadge>;
}

const SLA_CLASSES = {
  good: "text-[#0a6b0a]",
  warning: "text-[#8a5d00]",
  critical: "font-medium text-[#a32424]",
  info: "text-[#1d5aa3]",
  neutral: "text-admin-faint",
} as const;

/** "SLA: 1h 24m left", "Breached 3h ago" — with the due time on hover. */
export function SlaChip({ sla, className }: { sla: SlaState; className?: string }) {
  const { text, tone } = slaSummary(sla);
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap text-[0.6875rem] tabular-nums", SLA_CLASSES[tone], className)}
      title={sla.dueAt ? `Due ${formatDateTime(sla.dueAt)}` : undefined}
    >
      <AlarmClock className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden="true" />
      <span className="sr-only">SLA: </span>
      {text}
    </span>
  );
}

/** What this administrator may do in support — the API's answer, not a guess from the role. */
export function useSupportMe() {
  return useAdminResource<SupportMe>(() => getSupportMe(), []);
}

/** Shown to an administrator whose role doesn't include support. */
export function NoSupportAccess({ configure = false }: { configure?: boolean }) {
  return (
    <AdminCard>
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-[3px] bg-admin-raised">
          <Lock className="h-4 w-4 text-admin-muted" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <p className="mt-3 text-sm font-medium text-admin-ink">
          {configure ? "Only a super admin can configure support" : "Your role doesn't include support"}
        </p>
        <p className="mt-1 max-w-sm text-xs text-admin-muted">
          {configure
            ? "Ask a super admin to change teams, routing, SLAs or email templates."
            : "Ask a super admin to add you as a support agent, or to give your role the support permission."}
        </p>
        {configure ? (
          <AdminButtonLink href="/admin/support" size="sm" className="mt-4">
            Back to the support desk
          </AdminButtonLink>
        ) : null}
      </div>
    </AdminCard>
  );
}
