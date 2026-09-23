"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils/cn";

import { AdminPagination } from "./AdminPagination";

/**
 * One column in the shared admin table.
 *
 * `sortValue` is what makes a column sortable — providing it is the whole
 * opt-in, so there is no separate `sortable: true` that can disagree with
 * whether a sort key actually exists.
 */
export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  /** Extract the value to sort by. Omit for a column that cannot be sorted. */
  sortValue?: (row: T) => string | number;
  align?: "left" | "right" | "center";
  /**
   * Drop the column below this breakpoint.
   *
   * Narrow screens get the columns that identify a row; the rest are still
   * reachable by opening it. Better than shrinking twelve columns into an
   * unreadable smear.
   */
  hideBelow?: "sm" | "md" | "lg" | "xl";
  width?: string;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  getRowId: (row: T) => string;
  /** Row click target. Omit for tables whose actions live in a cell. */
  onRowClick?: (row: T) => void;
  isLoading?: boolean;
  pageSize?: number;
  /** Enables the checkbox column and bulk-action bar. */
  selectable?: boolean;
  onSelectionChange?: (ids: string[]) => void;
  /** Rendered above the table when rows are selected. */
  bulkActions?: (ids: string[], clear: () => void) => React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Default sort on first render. */
  initialSort?: { columnId: string; direction: "asc" | "desc" };
  className?: string;
}

const HIDE_BELOW: Record<NonNullable<Column<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
};

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

/**
 * The shared admin data table.
 *
 * Every list page in the portal uses this one component — products, orders,
 * customers, inventory, coupons, reviews and admin users — so sorting,
 * paging, selection, empty states and responsive behaviour are implemented
 * once and behave identically everywhere.
 *
 * Filtering is deliberately *not* here. Each page filters its own rows and
 * passes the result in, because the filter controls differ per page while the
 * table does not. Sorting and paging are the table's, because they are purely
 * mechanical.
 */
export function DataTable<T>({
  rows,
  columns,
  getRowId,
  onRowClick,
  isLoading = false,
  pageSize = 12,
  selectable = false,
  onSelectionChange,
  bulkActions,
  emptyTitle = "Nothing to show",
  emptyDescription = "Try adjusting the filters above.",
  initialSort,
  className,
}: DataTableProps<T>) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);

  // A filter change upstream shortens the list; staying on page 6 of the old
  // result set would show an empty table.
  useEffect(() => {
    setPage(1);
  }, [rows.length]);

  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((entry) => entry.id === sort.columnId);
    if (!column?.sortValue) return rows;

    const direction = sort.direction === "asc" ? 1 : -1;
    // Copy first: the caller owns `rows` and must not see it reordered.
    return [...rows].sort((a, b) => {
      const av = column.sortValue!(a);
      const bv = column.sortValue!(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * direction;
      return String(av).localeCompare(String(bv)) * direction;
    });
  }, [rows, sort, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visible = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const visibleIds = visible.map(getRowId);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id));

  const toggleSort = (column: Column<T>) => {
    if (!column.sortValue) return;
    setSort((current) =>
      current?.columnId === column.id
        ? { columnId: column.id, direction: current.direction === "asc" ? "desc" : "asc" }
        : { columnId: column.id, direction: "asc" },
    );
  };

  const toggleRow = (id: string) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  const clearSelection = () => setSelected([]);

  return (
    <div className={cn("flex flex-col", className)}>
      {selectable && selected.length > 0 && bulkActions ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[3px] border border-copper-200 bg-copper-50 px-3.5 py-2.5">
          <span className="text-sm text-admin-ink">
            {selected.length} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {bulkActions(selected, clearSelection)}
          </div>
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto text-xs text-admin-muted underline underline-offset-2 hover:text-admin-ink"
          >
            Clear
          </button>
        </div>
      ) : null}

      {/* Horizontal scroll is the escape hatch for wide tables on narrow
          screens; `hideBelow` keeps how often it is needed down. */}
      <div className="overflow-x-auto rounded-[3px] border border-admin-border bg-admin-surface">
        <table className="w-full min-w-[40rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-admin-border bg-admin-raised">
              {selectable ? (
                <th scope="col" className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...new Set([...selected, ...visibleIds])]
                          : selected.filter((id) => !visibleIds.includes(id)),
                      )
                    }
                    aria-label={
                      allVisibleSelected ? "Deselect all rows on this page" : "Select all rows on this page"
                    }
                    className="h-3.5 w-3.5 cursor-pointer accent-copper-600"
                  />
                </th>
              ) : null}

              {columns.map((column) => {
                const isSorted = sort?.columnId === column.id;
                const Icon = !column.sortValue
                  ? null
                  : !isSorted
                    ? ChevronsUpDown
                    : sort.direction === "asc"
                      ? ArrowUp
                      : ArrowDown;

                return (
                  <th
                    key={column.id}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    // Announces the current sort to assistive tech, which the
                    // arrow icon alone does not.
                    aria-sort={
                      isSorted ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
                    }
                    className={cn(
                      "px-3 py-2.5 label-wide font-medium text-admin-muted",
                      ALIGN[column.align ?? "left"],
                      column.hideBelow && HIDE_BELOW[column.hideBelow],
                    )}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className={cn(
                          "inline-flex items-center gap-1.5 transition-colors hover:text-admin-ink",
                          column.align === "right" && "flex-row-reverse",
                          isSorted && "text-admin-ink",
                        )}
                      >
                        {column.header}
                        {Icon ? <Icon className="h-3 w-3" strokeWidth={2} aria-hidden="true" /> : null}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {isLoading ? (
              Array.from({ length: 6 }, (_, index) => (
                <tr key={index} className="border-b border-admin-border last:border-0">
                  {selectable ? <td className="px-3 py-3" /> : null}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn("px-3 py-3", column.hideBelow && HIDE_BELOW[column.hideBelow])}
                    >
                      <span className="block h-3 w-full max-w-28 animate-pulse rounded-[2px] bg-admin-border" />
                    </td>
                  ))}
                </tr>
              ))
            ) : visible.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className="px-4 py-14 text-center"
                >
                  <p className="text-sm font-medium text-admin-ink">{emptyTitle}</p>
                  <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-admin-muted">
                    {emptyDescription}
                  </p>
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const id = getRowId(row);
                const isSelected = selected.includes(id);

                return (
                  <tr
                    key={id}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      "border-b border-admin-border last:border-0 transition-colors",
                      isSelected ? "bg-copper-50" : "hover:bg-admin-raised",
                      onRowClick && "cursor-pointer",
                    )}
                  >
                    {selectable ? (
                      <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRow(id)}
                          aria-label={`Select row ${id}`}
                          className="h-3.5 w-3.5 cursor-pointer accent-copper-600"
                        />
                      </td>
                    ) : null}

                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          "px-3 py-3 align-middle text-admin-ink",
                          ALIGN[column.align ?? "left"],
                          column.hideBelow && HIDE_BELOW[column.hideBelow],
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {!isLoading && sorted.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-admin-muted tabular-nums">
            Showing {(safePage - 1) * pageSize + 1}–
            {Math.min(safePage * pageSize, sorted.length)} of {sorted.length}
          </p>
          <AdminPagination page={safePage} totalPages={totalPages} onPageChange={setPage} />
        </div>
      ) : null}
    </div>
  );
}
