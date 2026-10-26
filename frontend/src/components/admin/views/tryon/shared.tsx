"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { StatusBadge, type Tone } from "@/components/admin/ui/StatusBadge";
import { useAdminSession } from "@/hooks/useAdminSession";
import { cn } from "@/lib/utils/cn";
import { REQUEST_TONES, STATE_LABELS, STATE_TONES } from "@/services/admin/tryOnAdminService";

const SECTIONS = [
  { href: "/admin/try-on", label: "Overview" },
  { href: "/admin/try-on/requests", label: "Requests" },
  { href: "/admin/try-on/credentials", label: "Credentials", secret: true },
  { href: "/admin/try-on/catalogue", label: "Models & categories" },
  { href: "/admin/try-on/plans", label: "Plan entitlements" },
  { href: "/admin/try-on/allocations", label: "Access & allocations" },
  { href: "/admin/try-on/settings", label: "Settings" },
];

/** The try-on area's own tabs, under every page's header. */
export function TryOnTabs() {
  const pathname = usePathname();
  const { can } = useAdminSession();
  return (
    <nav aria-label="Virtual try-on" className="-mt-2 mb-5 flex flex-wrap gap-1 border-b border-admin-border">
      {SECTIONS.filter((s) => !s.secret || can("manage:tryOnCredentials")).map((section) => {
        const active = section.href === "/admin/try-on" ? pathname === section.href : pathname.startsWith(section.href);
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-xs transition-colors",
              active ? "border-admin-ink font-medium text-admin-ink" : "border-transparent text-admin-muted hover:text-admin-ink",
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}

export const CRUMBS = [{ label: "Admin", href: "/admin/dashboard" }, { label: "Virtual try-on", href: "/admin/try-on" }];

/** A request's outcome as a badge: the failure's own label when it failed. */
export function RequestBadge({ status, badge }: { status: string; badge?: string }) {
  const label = status === "failed" ? badge || "Failed" : badge && status !== "succeeded" ? badge : STATUS_LABELS[status] ?? status;
  const tone: Tone = status === "failed" && badge === "Rate Limited" ? "warning" : REQUEST_TONES[status] ?? "neutral";
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

export const STATUS_LABELS: Record<string, string> = {
  succeeded: "Success",
  queued: "Queued",
  processing: "Processing",
  retrying: "Retrying",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
};

export function CredentialState({ state }: { state: string }) {
  return <StatusBadge tone={STATE_TONES[state] ?? "neutral"}>{STATE_LABELS[state] ?? state}</StatusBadge>;
}

/** "Not allowed" panel for administrators without the area's permission. */
export function NoAccess({ what }: { what: string }) {
  return (
    <div className="rounded-[3px] border border-admin-border bg-admin-surface px-4 py-10 text-center">
      <p className="text-sm font-medium text-admin-ink">You don&rsquo;t have access to {what}.</p>
      <p className="mt-1 text-xs text-admin-muted">Ask a super admin to add it to your role.</p>
    </div>
  );
}

export function seconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** A plain bar for a breakdown row: the share of the largest value. */
export function Bar({ value, max, tone = "ink" }: { value: number; max: number; tone?: "ink" | "bad" }) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="block h-1.5 w-full rounded-full bg-admin-raised" aria-hidden="true">
      <span className={cn("block h-1.5 rounded-full", tone === "bad" ? "bg-[#d03b3b]" : "bg-copper-500")} style={{ width: `${width}%` }} />
    </span>
  );
}
