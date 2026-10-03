"use client";

import { Lock } from "lucide-react";

import { AdminButtonLink, AdminCard } from "@/components/admin/ui/AdminChrome";
import { ApiError } from "@/services/api/client";
import type { AttributeType } from "@/types/searchAdmin";

export const ADMIN_CRUMB = { label: "Admin", href: "/admin/dashboard" };

export const TYPE_LABELS: Record<AttributeType, string> = {
  select: "Single choice",
  multi: "Multiple choice",
  number: "Number",
  boolean: "Yes / no",
};

/** Mirrors the server's rule: 2–40 lower-case letters, digits or _, starting with a letter. */
export const CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/** A code suggested from a label: "Sleeve length" → "sleeve_length". */
export function codeFromLabel(label: string): string {
  const code = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "");
  return code.slice(0, 40).replace(/_+$/, "");
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** The API's own words for a 4xx, a plain fallback for anything else. */
export function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError) || error.status >= 500) return fallback;
  return error.message || fallback;
}

export function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : "";
}

/** A full-card "your role doesn't include …" message for a 403. */
export function NoAccess({ permission }: { permission: string }) {
  return (
    <AdminCard>
      <div className="flex flex-col items-center px-4 py-10 text-center" role="alert">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-[3px] bg-admin-raised">
          <Lock className="h-4 w-4 text-admin-muted" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <p className="mt-3 text-sm font-medium text-admin-ink">Your role doesn&apos;t include {permission}</p>
        <p className="mt-1 max-w-sm text-xs text-admin-muted">
          Ask a super admin to give your role the {permission} permission.
        </p>
        <AdminButtonLink href="/admin/dashboard" size="sm" className="mt-4">
          Back to the dashboard
        </AdminButtonLink>
      </div>
    </AdminCard>
  );
}

export function percent(value: number): string {
  return `${value.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}

export function count(value: number): string {
  return value.toLocaleString("en-IN");
}
