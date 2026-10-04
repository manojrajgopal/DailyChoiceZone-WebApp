"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { X } from "lucide-react";

import type { AdminOrder, AdminOrderStatus, PaymentStatus } from "@/types/admin";

import { AdminButton, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { IdFilter } from "@/components/admin/ui/IdFilter";
import { IdLink } from "@/components/common/IdLink";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatDate, formatPrice, humanize } from "@/lib/utils/format";
import { ORDER_FLOW } from "@/lib/orders/orderFlow";
import { listOrders } from "@/services/admin/orderAdminService";

const ORDER_STATUSES: AdminOrderStatus[] = [...ORDER_FLOW, "cancelled", "returned"];

const PAYMENT_STATUSES: PaymentStatus[] = [
  "paid", "pending", "cod-pending", "failed", "refunded",
];

type DateWindow = "all" | "7d" | "30d" | "3m";

/**
 * All orders, with the filters an administrator actually works through.
 *
 * An order is found by its ID, never by a name (docs/id-lookup.md): the Order
 * ID and Customer ID filters go to the server, which matches them exactly.
 * Status, payment, date and amount narrow what came back.
 */
export function AdminOrdersView() {
  const [orderId, setOrderId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const { data, isLoading } = useAdminResource(
    () => listOrders({ q: orderId, customerId }),
    [orderId, customerId],
  );

  const [status, setStatus] = useState<AdminOrderStatus | "all">("all");
  const [payment, setPayment] = useState<PaymentStatus | "all">("all");
  const [window, setWindow] = useState<DateWindow>("all");
  const [minAmount, setMinAmount] = useState("");

  const orders = data ?? [];

  /**
   * "Now", captured once per mount — see `AdminCustomersView`. Reading the
   * clock inside the memo makes it impure and lets the date window drift.
   */
  const [now] = useState(() => Date.now());

  const filtered = useMemo(() => {
    const floor = Number(minAmount);
    const days = window === "7d" ? 7 : window === "30d" ? 30 : window === "3m" ? 90 : null;
    const cutoff = days ? now - days * 86400000 : null;

    return orders.filter((order) => {
      if (status !== "all" && order.status !== status) return false;
      if (payment !== "all" && order.paymentStatus !== payment) return false;
      if (cutoff && new Date(order.placedAt).getTime() < cutoff) return false;
      if (Number.isFinite(floor) && minAmount !== "" && order.totals.total < floor) return false;
      return true;
    });
  }, [orders, status, payment, window, minAmount, now]);

  const revenue = filtered
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + order.totals.total, 0);

  const hasFilters =
    status !== "all" || payment !== "all" || window !== "all" || minAmount !== "" || orderId !== "" || customerId !== "";

  const clear = () => {
    setStatus("all");
    setPayment("all");
    setWindow("all");
    setMinAmount("");
    setOrderId("");
    setCustomerId("");
  };

  const columns: Column<AdminOrder>[] = [
    {
      id: "orderNumber",
      header: "Order ID",
      sortValue: (order) => order.orderNumber,
      cell: (order) => (
        <Link
          href={`/admin/orders/detail?id=${order.id}`}
          className="font-medium text-admin-ink hover:text-copper-700"
        >
          #{order.orderNumber}
        </Link>
      ),
    },
    {
      id: "customer",
      header: "Customer",
      sortValue: (order) => order.customerName,
      cell: (order) => (
        <span className="min-w-0">
          <Link
            href={`/admin/customers/detail?id=${order.customerId}`}
            className="block max-w-[11rem] truncate text-admin-ink hover:text-copper-700"
          >
            {order.customerName}
          </Link>
          <IdLink entity="customer" id={order.customerId} href={`/admin/customers/detail?id=${order.customerId}`}
            className="block text-[0.625rem]" />
        </span>
      ),
    },
    {
      id: "date",
      header: "Date",
      hideBelow: "md",
      sortValue: (order) => order.placedAt,
      cell: (order) => (
        <span className="whitespace-nowrap text-xs text-admin-muted">
          {formatDate(order.placedAt)}
        </span>
      ),
    },
    {
      id: "items",
      header: "Items",
      align: "right",
      hideBelow: "sm",
      sortValue: (order) => order.totals.itemCount,
      cell: (order) => <span className="tabular-nums">{order.totals.itemCount}</span>,
    },
    {
      id: "total",
      header: "Total",
      align: "right",
      sortValue: (order) => order.totals.total,
      cell: (order) => (
        <span className="whitespace-nowrap font-medium tabular-nums">
          {formatPrice(order.totals.total)}
        </span>
      ),
    },
    {
      id: "payment",
      header: "Payment",
      hideBelow: "lg",
      sortValue: (order) => order.paymentStatus,
      cell: (order) => (
        <span className="flex flex-col gap-1">
          <DomainStatus domain="payment" status={order.paymentStatus} />
          <span className="text-[0.5625rem] text-admin-faint">{order.paymentMethod}</span>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (order) => order.status,
      cell: (order) => <DomainStatus domain="order" status={order.status} />,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (order) => (
        <Link
          href={`/admin/orders/detail?id=${order.id}`}
          className="text-[0.6875rem] font-medium text-copper-700 hover:text-admin-ink"
        >
          View
        </Link>
      ),
    },
  ];

  const selectClass =
    "h-8 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink hover:border-admin-border-strong focus:border-copper-500";

  return (
    <div>
      <AdminPageHeader
        title="Orders"
        description={orderId || customerId ? `${orders.length} orders for the ID chosen.` : `${orders.length} orders all told.`}
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Orders" }]}
      />

      <div className="mb-4 rounded-[3px] border border-admin-border bg-admin-surface p-3">
        <div className="mb-2 grid gap-2 sm:grid-cols-2 lg:max-w-2xl">
          <IdFilter entity="order" value={orderId} onChange={setOrderId} />
          <IdFilter entity="customer" value={customerId} onChange={setCustomerId} />
        </div>
        <div className="flex flex-wrap items-center gap-2">

          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as AdminOrderStatus | "all")}
            aria-label="Filter by order status"
            className={selectClass}
          >
            <option value="all">All statuses</option>
            {ORDER_STATUSES.map((option) => (
              <option key={option} value={option}>
                {humanize(option)}
              </option>
            ))}
          </select>

          <select
            value={payment}
            onChange={(event) => setPayment(event.target.value as PaymentStatus | "all")}
            aria-label="Filter by payment status"
            className={selectClass}
          >
            <option value="all">Any payment</option>
            {PAYMENT_STATUSES.map((option) => (
              <option key={option} value={option}>
                {humanize(option)}
              </option>
            ))}
          </select>

          <select
            value={window}
            onChange={(event) => setWindow(event.target.value as DateWindow)}
            aria-label="Filter by date"
            className={selectClass}
          >
            <option value="all">Any date</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="3m">Last 3 months</option>
          </select>

          <label className="flex items-center gap-1.5">
            <span className="text-xs text-admin-muted">Min ₹</span>
            <input
              type="number"
              min={0}
              value={minAmount}
              onChange={(event) => setMinAmount(event.target.value)}
              placeholder="0"
              className="h-8 w-20 rounded-[3px] border border-admin-border bg-admin-surface px-2 text-xs text-admin-ink focus:border-copper-500"
            />
          </label>

          {hasFilters ? (
            <AdminButton size="sm" variant="ghost" onClick={clear}>
              <X className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
              Clear
            </AdminButton>
          ) : null}
        </div>

        <p className="mt-2.5 text-[0.6875rem] text-admin-muted tabular-nums">
          {isLoading
            ? "Loading…"
            : `${filtered.length} of ${orders.length} orders · ${formatPrice(revenue)} excluding cancellations`}
        </p>
      </div>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowId={(order) => order.id}
        isLoading={isLoading}
        pageSize={15}
        initialSort={{ columnId: "date", direction: "desc" }}
        emptyTitle="No orders match"
        emptyDescription="Check the Order ID or Customer ID, or adjust the filters above."
      />
    </div>
  );
}
