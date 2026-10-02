"use client";

import { Lock } from "lucide-react";

import type { PurchaseOrderStatus, SupplierStatus } from "@/types/suppliers";

import { AdminButton, AdminButtonLink, AdminCard } from "@/components/admin/ui/AdminChrome";
import { StatusBadge, type Tone } from "@/components/admin/ui/StatusBadge";
import { STORE_TIME_ZONE } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";

export { rupees } from "@/components/admin/views/growth/shared";

/* ------------------------------------------------------------------ badges */

const SUPPLIER_TONES: Record<string, Tone> = { active: "good", inactive: "warning", archived: "neutral" };
const SUPPLIER_LABELS: Record<string, string> = { active: "Active", inactive: "Inactive", archived: "Archived" };

export function SupplierStatusBadge({ status }: { status: SupplierStatus | string }) {
  return <StatusBadge tone={SUPPLIER_TONES[status] ?? "neutral"}>{SUPPLIER_LABELS[status] ?? status}</StatusBadge>;
}

export const PO_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  sent: "Sent",
  acknowledged: "Acknowledged",
  "partially-received": "Partially received",
  received: "Received",
  cancelled: "Cancelled",
};

const PO_TONES: Record<string, Tone> = {
  draft: "neutral",
  submitted: "info",
  sent: "info",
  acknowledged: "info",
  "partially-received": "warning",
  received: "good",
  cancelled: "critical",
};

export function PoStatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <StatusBadge tone={PO_TONES[status] ?? "neutral"}>
      {label || PO_STATUS_LABELS[status as PurchaseOrderStatus] || status}
    </StatusBadge>
  );
}

/* ------------------------------------------------------------------ errors */

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** The API's own words when it gave some, a plain fallback otherwise. */
export function problem(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}

/**
 * Field errors from a failed save.
 *
 * - a known error code mapped to the field it is about (409 SUPPLIER_CODE_TAKEN → `code`);
 * - `details.field` on an application error (the message is the error's own);
 * - `details: [{ field, message }]` from request validation.
 */
export function serverFieldErrors(error: unknown, codeFields: Record<string, string> = {}): Record<string, string> {
  if (!(error instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  const byCode = codeFields[error.code];
  if (byCode) out[byCode] = error.message;
  const details = error.details as unknown;
  const clean = (field: string) => field.replace(/^body\./, "");
  if (Array.isArray(details)) {
    for (const entry of details) {
      if (entry && typeof entry === "object" && typeof (entry as { field?: unknown }).field === "string") {
        const { field, message } = entry as { field: string; message?: string };
        out[clean(field)] = message || error.message;
      }
    }
  } else if (details && typeof details === "object" && typeof (details as { field?: unknown }).field === "string") {
    out[clean((details as { field: string }).field)] = error.message;
  }
  return out;
}

/* ------------------------------------------------------------------ states */

/** Shown to an administrator whose role doesn't include this area. */
export function NoAccess({ area }: { area: "suppliers" | "purchasing" }) {
  return (
    <AdminCard>
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-[3px] bg-admin-raised">
          <Lock className="h-4 w-4 text-admin-muted" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <p className="mt-3 text-sm font-medium text-admin-ink">
          {area === "suppliers" ? "Your role doesn't include suppliers" : "Your role doesn't include purchasing"}
        </p>
        <p className="mt-1 max-w-sm text-xs text-admin-muted">
          Ask a super admin to give your role the {area === "suppliers" ? "suppliers" : "purchasing"} permission.
        </p>
        <AdminButtonLink href="/admin/dashboard" size="sm" className="mt-4">
          Back to the dashboard
        </AdminButtonLink>
      </div>
    </AdminCard>
  );
}

export function LoadFailed({ message, onRetry }: { message?: string; onRetry: () => void }) {
  return (
    <AdminCard>
      <div className="px-4 py-10 text-center" role="alert">
        <p className="text-sm text-admin-ink">{message || "This didn’t load."}</p>
        <AdminButton size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </AdminButton>
      </div>
    </AdminCard>
  );
}

export function PageSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="flex flex-col gap-4">
      <span className="block h-6 w-56 animate-pulse rounded-[2px] bg-admin-border" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <span key={index} className="block h-20 animate-pulse rounded-[3px] bg-admin-border/60" />
        ))}
      </div>
      <span className="block h-48 animate-pulse rounded-[3px] bg-admin-border/60" />
    </div>
  );
}

/* ------------------------------------------------------------------- dates */

const DAY_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: STORE_TIME_ZONE });

/** Today as YYYY-MM-DD in the store's clock. */
export function todayKey(now: Date = new Date()): string {
  return DAY_KEY.format(now);
}

/** A fresh idempotency key. */
export function newKey(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export const SUPPLIERS_CRUMB = { label: "Suppliers", href: "/admin/suppliers" };
export const PURCHASE_ORDERS_CRUMB = { label: "Purchase orders", href: "/admin/purchase-orders" };
export const ADMIN_CRUMB = { label: "Admin", href: "/admin/dashboard" };
