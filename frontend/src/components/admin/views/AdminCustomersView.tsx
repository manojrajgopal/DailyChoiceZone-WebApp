"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { X } from "lucide-react";

import type { AdminCustomer } from "@/types/admin";

import { AdminButton, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { useUrlFilters } from "@/components/admin/ui/LogPage";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { listCustomers } from "@/services/admin/customerAdminService";

type Segment = "all" | "repeat" | "new" | "lapsed" | "blocked";

/**
 * The customer list.
 *
 * Segments rather than a pile of raw filters, because "who is buying
 * repeatedly" and "who has gone quiet" are the questions actually asked of
 * this page.
 *
 * One customer is found by Customer ID (docs/id-lookup.md), picked from the
 * autocomplete and matched exactly by the server; names, emails and phone
 * numbers are shown, never searched.
 */
const KEYS = ["q"] as const;

export function AdminCustomersView() {
  const { filters, setFilters, clear } = useUrlFilters(KEYS);
  const customerId = filters.q;
  const { data, isLoading } = useAdminResource(() => listCustomers(customerId), [customerId]);

  const [segment, setSegment] = useState<Segment>("all");

  const customers = data ?? [];

  /**
   * "Now", captured once per mount.
   *
   * Reading the clock inside the memo would make it impure — and would let
   * the lapsed-customer window drift while the page sits open, so a row
   * could appear or vanish without anything being changed.
   */
  const [now] = useState(() => Date.now());

  const filtered = useMemo(() => {
    const ninetyDaysAgo = now - 90 * 86400000;

    return customers.filter((customer) => {
      if (segment === "blocked" && customer.status !== "blocked") return false;
      if (segment === "repeat" && customer.orderCount < 2) return false;
      if (segment === "new" && customer.orderCount > 1) return false;
      if (segment === "lapsed") {
        const last = customer.lastOrderAt ? new Date(customer.lastOrderAt).getTime() : 0;
        if (customer.orderCount === 0 || last >= ninetyDaysAgo) return false;
      }

      return true;
    });
  }, [customers, segment, now]);

  const totalSpent = filtered.reduce((sum, customer) => sum + customer.totalSpent, 0);

  const columns: Column<AdminCustomer>[] = [
    {
      id: "customer",
      header: "Customer",
      sortValue: (customer) => `${customer.firstName} ${customer.lastName}`,
      cell: (customer) => (
        <span className="flex items-center gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-pill bg-admin-raised text-[0.625rem] font-semibold text-admin-muted">
            {customer.firstName.charAt(0)}
            {customer.lastName.charAt(0)}
          </span>
          <span className="min-w-0">
            <Link
              href={`/admin/customers/detail?id=${customer.id}`}
              className="block truncate text-admin-ink hover:text-copper-700"
            >
              {customer.firstName} {customer.lastName}
            </Link>
            <span className="block max-w-[12rem] truncate text-[0.625rem] text-admin-faint">
              {customer.email}
            </span>
          </span>
        </span>
      ),
    },
    {
      id: "phone",
      header: "Phone",
      hideBelow: "lg",
      cell: (customer) => (
        <span className="whitespace-nowrap text-xs text-admin-muted tabular-nums">
          +91 {customer.phone}
        </span>
      ),
    },
    {
      id: "orders",
      header: "Orders",
      align: "right",
      sortValue: (customer) => customer.orderCount,
      cell: (customer) => <span className="tabular-nums">{customer.orderCount}</span>,
    },
    {
      id: "spent",
      header: "Total spent",
      align: "right",
      sortValue: (customer) => customer.totalSpent,
      cell: (customer) => (
        <span className="whitespace-nowrap font-medium tabular-nums">
          {formatPrice(customer.totalSpent)}
        </span>
      ),
    },
    {
      id: "lastOrder",
      header: "Last order",
      hideBelow: "md",
      sortValue: (customer) => customer.lastOrderAt ?? "",
      cell: (customer) => (
        <span className="whitespace-nowrap text-xs text-admin-muted">
          {customer.lastOrderAt ? formatDate(customer.lastOrderAt) : "Never"}
        </span>
      ),
    },
    {
      id: "joined",
      header: "Joined",
      hideBelow: "xl",
      sortValue: (customer) => customer.joinedAt,
      cell: (customer) => (
        <span className="whitespace-nowrap text-xs text-admin-muted">
          {formatDate(customer.joinedAt)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (customer) => customer.status,
      cell: (customer) => <DomainStatus domain="generic" status={customer.status} />,
    },
  ];

  const SEGMENTS: { value: Segment; label: string }[] = [
    { value: "all", label: "All customers" },
    { value: "repeat", label: "Repeat buyers" },
    { value: "new", label: "First order or none" },
    { value: "lapsed", label: "Lapsed (90+ days)" },
    { value: "blocked", label: "Blocked" },
  ];

  return (
    <div>
      <AdminPageHeader
        title="Customers"
        description={customerId ? `Customer ${customerId}.` : `${customers.length} registered customers.`}
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Customers" }]}
      />

      <div className="mb-4 rounded-[3px] border border-admin-border bg-admin-surface p-3">
        <div className="flex flex-wrap items-end gap-2">
          <IdFilter
            entity="customer"
            value={customerId}
            onChange={(q) => setFilters({ q })}
            className="min-w-0 flex-1 sm:max-w-xs"
          />

          <select
            value={segment}
            onChange={(event) => setSegment(event.target.value as Segment)}
            aria-label="Filter by segment"
            className="h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink hover:border-admin-border-strong focus:border-copper-500"
          >
            {SEGMENTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {segment !== "all" || customerId ? (
            <AdminButton
              size="sm"
              variant="ghost"
              onClick={() => {
                setSegment("all");
                clear();
              }}
            >
              <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              Clear
            </AdminButton>
          ) : null}
        </div>

        <p className="mt-2.5 text-[0.6875rem] text-admin-muted tabular-nums">
          {isLoading
            ? "Loading…"
            : `${filtered.length} of ${customers.length} customers · ${formatPrice(totalSpent)} lifetime value`}
        </p>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(customer) => customer.id}
        isLoading={isLoading}
        pageSize={15}
        initialSort={{ columnId: "spent", direction: "desc" }}
        emptyTitle="No customers match"
        emptyDescription="Adjust the Customer ID or segment above."
      />
    </div>
  );
}
