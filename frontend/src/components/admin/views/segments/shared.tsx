"use client";

import { Lock } from "lucide-react";

import { AdminButtonLink, AdminCard } from "@/components/admin/ui/AdminChrome";
import { StatusBadge } from "@/components/admin/ui/StatusBadge";
import { rupees } from "@/components/admin/views/growth/shared";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import type {
  RuleValue,
  SegmentCondition,
  SegmentField,
  SegmentFieldRegistry,
  SegmentGroup,
  SegmentKind,
  SegmentMatch,
  SegmentRule,
  SegmentStatus,
} from "@/types/segments";

export { LoadFailed, PageSkeleton, isForbidden, isNotFound } from "@/components/admin/views/suppliers/shared";
export { rupees };

/* ------------------------------------------------------------------ crumbs */

export const ADMIN_CRUMB = { label: "Admin", href: "/admin/dashboard" };
export const CUSTOMERS_CRUMB = { label: "Customers", href: "/admin/customers" };
export const SEGMENTS_CRUMB = { label: "Segments", href: "/admin/customers/segments" };

export const segmentHref = (id: number) => `/admin/customers/segments/detail?id=${id}`;
export const editHref = (id: number) => `/admin/customers/segments/edit?id=${id}`;

/* ------------------------------------------------------------------ badges */

export function SegmentKindBadge({ kind }: { kind: SegmentKind | string }) {
  return <StatusBadge tone={kind === "default" ? "info" : "neutral"}>{kind === "default" ? "Default" : "Custom"}</StatusBadge>;
}

export function SegmentStatusBadge({ status }: { status: SegmentStatus | string }) {
  return <StatusBadge tone={status === "active" ? "good" : "neutral"}>{status === "active" ? "Active" : "Archived"}</StatusBadge>;
}

/** The RFM label keys (docs §3), for when the server sends a key without its label. */
export const RFM_LABELS: Record<string, string> = {
  champions: "Champions",
  loyal: "Loyal",
  potential: "Potential",
  new: "New",
  "at-risk": "At risk",
  hibernating: "Hibernating",
  lost: "Lost",
  "no-orders": "No orders",
};

/* ------------------------------------------------------------------ errors */

/**
 * What to tell the admin when a call fails.
 *
 * The segment API's messages are written for people ("Total spend: “between”
 * needs two amounts, the lower first."), so they are shown as they are. A
 * server crash (5xx) gets the plain fallback rather than whatever it said.
 */
export function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status >= 500) return fallback;
  if (error.code === "SEGMENT_NAME_TAKEN") return error.message || "Another segment already has this name.";
  if (error.code === "SEGMENT_ARCHIVED") return error.message || "This segment is archived. Restore it to change it.";
  if (error.code === "SEGMENT_NOT_FOUND") return error.message || "That segment no longer exists.";
  return error.message || fallback;
}

/** `details.path` of a rule error ("rules.1.rules.0") as indices: [1, 0]. */
export function rulePath(error: unknown): number[] | null {
  if (!(error instanceof ApiError)) return null;
  const path = (error.details as { path?: unknown } | null | undefined)?.path;
  if (typeof path !== "string") return null;
  const indices = [...path.matchAll(/rules\.(\d+)/g)].map((match) => Number(match[1]));
  return indices.length ? indices : null;
}

/* ------------------------------------------------------------------ states */

export function SegmentsNoAccess() {
  return (
    <AdminCard>
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-[3px] bg-admin-raised">
          <Lock className="h-4 w-4 text-admin-muted" strokeWidth={1.75} aria-hidden="true" />
        </span>
        <p className="mt-3 text-sm font-medium text-admin-ink">Your role doesn&apos;t include segments</p>
        <p className="mt-1 max-w-sm text-xs text-admin-muted">Ask a super admin to give your role the segments permission.</p>
        <AdminButtonLink href="/admin/dashboard" size="sm" className="mt-4">
          Back to the dashboard
        </AdminButtonLink>
      </div>
    </AdminCard>
  );
}

/* ------------------------------------------------------------------- rules */

export function isGroup(rule: SegmentRule): rule is SegmentGroup {
  return Array.isArray((rule as SegmentGroup).rules);
}

export function countConditions(rules: SegmentRule[] | unknown): number {
  if (!Array.isArray(rules)) return 0;
  return (rules as SegmentRule[]).reduce((total, rule) => total + (isGroup(rule) ? rule.rules.length : 1), 0);
}

const SHORT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One value as a person reads it, in the field's terms. */
export function formatRuleValue(field: SegmentField | undefined, value: RuleValue): string {
  const one = (entry: string | number | boolean | null): string => {
    if (entry === null || entry === "") return "…";
    if (typeof entry === "boolean") return entry ? "yes" : "no";
    if (field?.type === "money" && typeof entry === "number") return rupees(entry);
    if (field?.type === "date" && typeof entry === "string" && SHORT_DATE.test(entry)) return formatDate(entry);
    const option = field?.options?.find((candidate) => String(candidate.value) === String(entry));
    if (option) return option.label;
    if (typeof entry === "number") return entry.toLocaleString("en-IN");
    return String(entry);
  };
  if (Array.isArray(value)) return value.map((entry) => one(entry)).join(", ");
  return one(value);
}

/** "Total spend is at least ₹10,000" — a condition in words. */
export function describeCondition(condition: SegmentCondition, registry: SegmentFieldRegistry | null): string {
  const field = registry?.fields.find((candidate) => candidate.key === condition.field);
  const operator = registry?.operators.find((candidate) => candidate.key === condition.operator);
  const label = field?.label ?? condition.field;
  const verb = operator?.label ?? condition.operator;
  const kind = operator?.value;
  if (kind === "none") return `${label} ${verb}`;
  if (kind === "days") return `${label} ${verb} ${condition.value ?? "…"} days`;
  if (kind === "range" && Array.isArray(condition.value)) {
    const [low, high] = condition.value;
    return `${label} ${verb} ${formatRuleValue(field, low ?? null)} and ${formatRuleValue(field, high ?? null)}`;
  }
  if (field?.type === "boolean") return `${label} ${verb} ${formatRuleValue(field, condition.value)}`;
  return `${label} ${verb} ${formatRuleValue(field, condition.value)}`;
}

export const MATCH_WORDS: Record<SegmentMatch, string> = { all: "all", any: "any" };

/** The rules in words: a sentence per condition, groups indented under their own match. */
export function RulesSummary({
  match,
  rules,
  registry,
  className,
}: {
  match: SegmentMatch;
  rules: SegmentRule[];
  registry: SegmentFieldRegistry | null;
  className?: string;
}) {
  if (!rules.length) {
    return <p className={cn("text-xs text-admin-muted", className)}>No conditions: every customer matches.</p>;
  }
  return (
    <div className={cn("text-xs text-admin-ink", className)}>
      <p className="mb-1.5 text-admin-muted">
        Customers who match <strong className="text-admin-ink">{MATCH_WORDS[match]}</strong> of these:
      </p>
      <ul className="flex flex-col gap-1.5" aria-label="Rules">
        {rules.map((rule, index) =>
          isGroup(rule) ? (
            <li key={index} className="rounded-[3px] border border-admin-border bg-admin-raised px-2.5 py-2">
              <p className="mb-1 text-admin-muted">
                <strong className="text-admin-ink">{MATCH_WORDS[rule.match]}</strong> of:
              </p>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {rule.rules.map((condition, inner) => (
                  <li key={inner}>{describeCondition(condition, registry)}</li>
                ))}
              </ul>
            </li>
          ) : (
            <li key={index} className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-admin-muted" aria-hidden="true" />
              <span>{describeCondition(rule, registry)}</span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

/** The admin form control look, for selects and inputs that sit in a dense row without a visible label. */
export const CONTROL =
  "h-9 w-full rounded-[3px] border border-admin-border bg-admin-surface px-2.5 text-[0.8125rem] text-admin-ink " +
  "placeholder:text-admin-faint transition-colors hover:border-admin-border-strong focus:border-copper-500 " +
  "disabled:cursor-not-allowed disabled:bg-admin-raised disabled:text-admin-faint";

/** All / Any, as a two-button toggle. */
export function MatchToggle({
  value,
  onChange,
  label,
  disabled,
}: {
  value: SegmentMatch;
  onChange: (value: SegmentMatch) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[3px] ring-1 ring-inset ring-admin-border">
      {(["all", "any"] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          disabled={disabled}
          onClick={() => onChange(option)}
          className={cn(
            "h-8 px-3 text-xs font-medium transition-colors first:rounded-l-[3px] last:rounded-r-[3px] disabled:cursor-not-allowed",
            value === option ? "bg-admin-ink text-white" : "text-admin-muted hover:text-admin-ink",
          )}
        >
          {option === "all" ? "All (AND)" : "Any (OR)"}
        </button>
      ))}
    </div>
  );
}
