"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { AdminPagination } from "./AdminPagination";

/**
 * Pieces shared by the full-page logs ("View all" destinations): filters kept
 * in the address bar, status tabs with counts, a search box, page size, the
 * paging footer and CSV export. Filtering and paging happen on the server.
 */

export const PAGE_SIZES = [25, 50, 100];

/**
 * Filters read from and written to the query string, so a filtered view can
 * be bookmarked, shared or reached with the back button. Changing any filter
 * returns to page 1.
 */
export function useUrlFilters<K extends string>(keys: readonly K[]) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = useMemo(() => {
    const out = {} as Record<K, string>;
    for (const key of keys) out[key] = params.get(key) ?? "";
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = PAGE_SIZES.includes(Number(params.get("pageSize"))) ? Number(params.get("pageSize")) : PAGE_SIZES[0]!;

  const write = useCallback(
    (next: Record<string, string | number | undefined>) => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(next)) {
        if (value !== undefined && value !== "" && !(key === "page" && value === 1) && !(key === "pageSize" && value === PAGE_SIZES[0])) {
          search.set(key, String(value));
        }
      }
      const text = search.toString();
      router.replace(`${pathname}${text ? `?${text}` : ""}`, { scroll: false });
    },
    [pathname, router],
  );

  const setFilters = useCallback(
    (patch: Partial<Record<K, string>>) => write({ ...filters, ...patch, pageSize, page: 1 }),
    [filters, pageSize, write],
  );
  const setPage = useCallback((next: number) => write({ ...filters, pageSize, page: next }), [filters, pageSize, write]);
  const setPageSize = useCallback((next: number) => write({ ...filters, pageSize: next, page: 1 }), [filters, write]);
  const clear = useCallback(() => write({ pageSize }), [pageSize, write]);

  return { filters, page, pageSize, setFilters, setPage, setPageSize, clear };
}

/** A search box that applies a moment after typing stops. */
export function LogSearch({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  const [term, setTerm] = useState(value);
  // Follow the applied value when it changes from outside (e.g. "Clear filters").
  const [applied, setApplied] = useState(value);
  if (value !== applied) {
    setApplied(value);
    if (value !== term.trim()) setTerm(value);
  }
  useEffect(() => {
    const timer = setTimeout(() => {
      if (term.trim() !== value) onChange(term.trim());
    }, 350);
    return () => clearTimeout(timer);
  }, [term, value, onChange]);

  return (
    <div className="relative min-w-[14rem] flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-admin-faint" aria-hidden="true" />
      <input
        type="search"
        aria-label={label}
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder={placeholder}
        className="h-9 w-full rounded-[3px] border border-admin-border bg-admin-surface pl-8 pr-2.5 text-[0.8125rem] text-admin-ink placeholder:text-admin-faint hover:border-admin-border-strong focus:border-copper-500"
      />
    </div>
  );
}

/** Status tabs, each with its count. */
export function StatusTabs({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[3px] px-2.5 py-1.5 text-xs transition-colors",
            value === tab.value
              ? "bg-admin-ink text-white"
              : "bg-admin-surface text-admin-muted ring-1 ring-inset ring-admin-border hover:text-admin-ink",
          )}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span
              className={cn(
                "rounded-[3px] px-1 text-[0.625rem] tabular-nums",
                value === tab.value ? "bg-white/20" : "bg-admin-raised text-admin-muted",
              )}
            >
              {tab.count.toLocaleString("en-IN")}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** A compact select for the filter bar, labelled for screen readers. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 cursor-pointer rounded-[3px] border border-admin-border bg-admin-surface px-2 text-[0.8125rem] text-admin-ink hover:border-admin-border-strong"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** "Showing 26–50 of 312", rows per page, and the pager. */
export function LogFooter({
  page,
  pageSize,
  total,
  totalPages,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  if (total === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3 text-xs text-admin-muted">
        <span className="tabular-nums">
          Showing {((page - 1) * pageSize + 1).toLocaleString("en-IN")}–{Math.min(page * pageSize, total).toLocaleString("en-IN")} of{" "}
          {total.toLocaleString("en-IN")}
        </span>
        <label className="flex items-center gap-1.5">
          Rows per page
          <select
            value={pageSize}
            onChange={(event) => onPageSize(Number(event.target.value))}
            className="h-7 cursor-pointer rounded-[3px] border border-admin-border bg-admin-surface px-1.5 text-xs text-admin-ink"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>
      <AdminPagination page={page} totalPages={totalPages} onPageChange={onPage} />
    </div>
  );
}

/** Save rows as a CSV file the browser downloads. */
export function downloadCsv(fileName: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const cell = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? "" : String(value);
    // Quote everything; a leading = + - @ is prefixed so a spreadsheet never runs it as a formula.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const csv = [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Every page of a filtered result, for export — capped so a huge log can't stall the tab. */
export async function collectPages<T>(
  load: (page: number) => Promise<{ items: T[]; pagination: { total_pages: number } }>,
  maxPages = 20,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  const first = await load(1);
  rows.push(...first.items);
  const last = Math.min(first.pagination.total_pages, maxPages);
  for (let page = 2; page <= last; page += 1) rows.push(...(await load(page)).items);
  return { rows, truncated: first.pagination.total_pages > maxPages };
}
