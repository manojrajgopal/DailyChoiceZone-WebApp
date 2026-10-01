"use client";

import { AdminButton } from "@/components/admin/ui/AdminChrome";
import { cn } from "@/lib/utils/cn";
import { ApiError } from "@/services/api/client";

export { Badge } from "@/components/admin/views/AdminMembershipView";

/** The API's own words when it gave some, a plain fallback otherwise. */
export function problem(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** A headline number. `null` value shows a placeholder while it loads. */
export function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | null;
  hint?: string;
  tone?: "good" | "bad" | "warn";
}) {
  return (
    <div className="rounded-[3px] border border-admin-border bg-admin-surface p-3.5">
      <p className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">{label}</p>
      <p
        className={cn(
          "mt-1.5 text-xl font-semibold tabular-nums",
          tone === "good" ? "text-[#0a6b0a]" : tone === "bad" ? "text-[#a32424]" : tone === "warn" ? "text-[#8a5a12]" : "text-admin-ink",
        )}
      >
        {value ?? <span className="inline-block h-5 w-12 animate-pulse rounded-[2px] bg-admin-border" />}
      </p>
      {hint ? <p className="mt-1 text-[0.6875rem] text-admin-muted">{hint}</p> : null}
    </div>
  );
}

export function Detail({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn(wide && "sm:col-span-2")}>
      <dt className="text-[0.6875rem] text-admin-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-admin-ink">{children}</dd>
    </div>
  );
}

/** Table body states: loading rows, an empty message, or a load failure. */
export function TableState({
  columns,
  loading,
  failed,
  empty,
  onRetry,
  title,
  hint,
}: {
  columns: number;
  loading: boolean;
  failed: boolean;
  empty: boolean;
  onRetry: () => void;
  title: string;
  hint: string;
}) {
  if (loading) {
    return (
      <>
        {Array.from({ length: 6 }, (_, index) => (
          <tr key={index}>
            {Array.from({ length: columns }, (__, cell) => (
              <td key={cell} className="px-3 py-3.5">
                <span className="block h-3 w-full max-w-28 animate-pulse rounded-[2px] bg-admin-border" />
              </td>
            ))}
          </tr>
        ))}
      </>
    );
  }
  if (failed) {
    return (
      <tr>
        <td colSpan={columns} className="px-4 py-12 text-center">
          <p className="text-sm text-admin-ink">This didn&rsquo;t load.</p>
          <AdminButton size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </AdminButton>
        </td>
      </tr>
    );
  }
  if (empty) {
    return (
      <tr>
        <td colSpan={columns} className="px-4 py-14 text-center">
          <p className="text-sm font-medium text-admin-ink">{title}</p>
          <p className="mt-1 text-xs text-admin-muted">{hint}</p>
        </td>
      </tr>
    );
  }
  return null;
}

/** Pretty-printed JSON for a detail panel. */
export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-[3px] border border-admin-border bg-admin-raised p-3 text-[0.6875rem] leading-relaxed text-admin-ink">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export const TH = "px-3 py-2.5 font-medium";
export const TD = "px-3 py-3";
