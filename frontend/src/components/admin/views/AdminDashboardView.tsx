"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Package } from "lucide-react";

import type { AnalyticsRange } from "@/types/admin";

import { BarList } from "@/components/admin/charts/BarList";
import { TimeSeriesChart } from "@/components/admin/charts/TimeSeriesChart";
import {
  AdminButtonLink,
  AdminCard,
  AdminPageHeader,
} from "@/components/admin/ui/AdminChrome";
import { DataTable, type Column } from "@/components/admin/ui/DataTable";
import { DomainStatus } from "@/components/admin/ui/StatusBadge";
import { StatCard } from "@/components/admin/ui/StatCard";
import { useAdminResource } from "@/hooks/useAdminResource";
import { useAdminSession } from "@/hooks/useAdminSession";
import { cn } from "@/lib/utils/cn";
import { formatCompactINR, formatDate, formatPrice, humanize } from "@/lib/utils/format";
import { RANGES, getAnalytics, getDashboard } from "@/services/admin/analyticsAdminService";
import { listLowStock } from "@/services/admin/inventoryAdminService";
import { listOrders } from "@/services/admin/orderAdminService";

import type { AdminOrder } from "@/types/admin";

/**
 * The admin dashboard.
 *
 * Ordered by what an administrator opens it to find out, in order: how much did
 * we take, what needs doing, what is selling, and what is about to run out.
 */
export function AdminDashboardView() {
  const { user } = useAdminSession();
  const [range, setRange] = useState<AnalyticsRange>("30d");

  const dashboard = useAdminResource(() => getDashboard(), []);
  const analytics = useAdminResource(() => getAnalytics(range), [range]);
  const orders = useAdminResource(() => listOrders(), []);
  const lowStock = useAdminResource(() => listLowStock(5), []);

  const recentOrders = (orders.data ?? []).slice(0, 8);
  const snapshot = analytics.data;

  const orderColumns: Column<AdminOrder>[] = [
    {
      id: "orderNumber",
      header: "Order",
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
      cell: (order) => <span className="truncate">{order.customerName}</span>,
    },
    {
      id: "date",
      header: "Date",
      hideBelow: "md",
      cell: (order) => (
        <span className="whitespace-nowrap text-admin-muted">{formatDate(order.placedAt)}</span>
      ),
    },
    {
      id: "items",
      header: "Items",
      align: "right",
      hideBelow: "sm",
      cell: (order) => <span className="tabular-nums">{order.totals.itemCount}</span>,
    },
    {
      id: "total",
      header: "Amount",
      align: "right",
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
      cell: (order) => <DomainStatus domain="payment" status={order.paymentStatus} />,
    },
    {
      id: "status",
      header: "Status",
      cell: (order) => <DomainStatus domain="order" status={order.status} />,
    },
  ];

  return (
    <div>
      <AdminPageHeader
        title={`Good day${user ? `, ${user.name.split(" ")[0]}` : ""}`}
        description="Everything that needs your attention today, in one place."
        actions={
          <AdminButtonLink href="/admin/products/new" variant="primary">
            Add product
          </AdminButtonLink>
        }
      />

      {/* ------------------------------------------------------- KPI tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {dashboard.isLoading
          ? Array.from({ length: 5 }, (_, index) => (
              <div
                key={index}
                className="h-[6.5rem] animate-pulse rounded-[3px] border border-admin-border bg-admin-surface"
              />
            ))
          : (dashboard.data?.stats ?? []).map((stat) => <StatCard key={stat.id} stat={stat} />)}
      </div>

      {/* -------------------------------------------------- sales overview */}
      <div className="mt-4">
        <AdminCard
          title="Sales overview"
          description={snapshot ? `${snapshot.orders} orders · ${formatCompactINR(snapshot.revenue)} revenue` : undefined}
          action={
            <div
              role="group"
              aria-label="Time range"
              className="flex overflow-hidden rounded-[3px] border border-admin-border"
            >
              {RANGES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setRange(option.value)}
                  aria-pressed={range === option.value}
                  className={cn(
                    "px-2.5 py-1 text-[0.6875rem] font-medium transition-colors",
                    range === option.value
                      ? "bg-admin-ink text-white"
                      : "bg-admin-surface text-admin-muted hover:bg-admin-raised",
                  )}
                >
                  {option.shortLabel}
                </button>
              ))}
            </div>
          }
        >
          {/*
            Two charts, never one with two y-axes. Revenue in rupees and a count
            of orders share no scale, and overlaying them would invent a
            crossover that means nothing.
          */}
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-admin-ink">Revenue</p>
              <p className="mb-3 text-[0.625rem] text-admin-muted">
                Hover the line for an exact figure.
              </p>
              {snapshot ? (
                <TimeSeriesChart points={snapshot.series} metric="revenue" />
              ) : (
                <div className="h-[220px] animate-pulse rounded-[3px] bg-admin-raised" />
              )}
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-admin-ink">Orders</p>
              <p className="mb-3 text-[0.625rem] text-admin-muted">
                Count of orders placed, excluding cancellations.
              </p>
              {snapshot ? (
                <TimeSeriesChart points={snapshot.series} metric="orders" />
              ) : (
                <div className="h-[220px] animate-pulse rounded-[3px] bg-admin-raised" />
              )}
            </div>
          </div>
        </AdminCard>
      </div>

      {/* ------------------------------------- breakdowns and low stock */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <AdminCard title="Sales by category" description="Revenue in the selected range">
          {/* Nominal categories: one hue for all bars. Bar length already
              encodes the value, so colour has no second job to do. */}
          <BarList
            data={(snapshot?.byCategory ?? []).slice(0, 7).map((entry) => ({
              label: humanize(entry.category),
              value: entry.revenue,
              meta: `${entry.units} units`,
            }))}
            scale="nominal"
            valueFormat={formatCompactINR}
          />
        </AdminCard>

        <AdminCard title="Order status" description="Where current orders sit">
          {/* An order funnel is ordinal — pending through delivered is a
              sequence — so a light-to-dark ramp puts that order in the colour. */}
          <BarList
            data={(snapshot?.byStatus ?? []).map((entry) => ({
              label: humanize(entry.status),
              value: entry.count,
            }))}
            scale="ordinal"
          />
        </AdminCard>

        <AdminCard
          title="Low stock"
          description="Running out soonest first"
          action={
            <Link
              href="/admin/inventory"
              className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-copper-700 hover:text-admin-ink"
            >
              View inventory
              <ArrowRight className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            </Link>
          }
        >
          {lowStock.isLoading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="h-8 animate-pulse rounded-[3px] bg-admin-raised" />
              ))}
            </div>
          ) : (lowStock.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-xs text-admin-muted">
              Everything is comfortably in stock.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-admin-border">
              {(lowStock.data ?? []).map((item) => (
                <li key={item.productId} className="flex items-center gap-2.5 py-2 first:pt-0">
                  <Package
                    className="h-3.5 w-3.5 shrink-0 text-admin-faint"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <Link
                      href={`/admin/products/edit?id=${item.productId}`}
                      className="block truncate text-xs text-admin-ink hover:text-copper-700"
                    >
                      {item.name}
                    </Link>
                    <span className="block text-[0.625rem] text-admin-muted">{item.sku}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs font-medium tabular-nums",
                      item.available === 0 ? "text-[#a32424]" : "text-[#8a5d00]",
                    )}
                  >
                    {item.available === 0 ? "Out" : `Only ${item.available} left`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AdminCard>
      </div>

      {/* ------------------------------------------------- recent orders */}
      <div className="mt-4">
        <AdminCard
          title="Recent orders"
          description="The eight most recent, newest first"
          padded={false}
          action={
            <Link
              href="/admin/orders"
              className="inline-flex items-center gap-1 text-[0.6875rem] font-medium text-copper-700 hover:text-admin-ink"
            >
              All orders
              <ArrowRight className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            </Link>
          }
        >
          <div className="p-4">
            <DataTable
              rows={recentOrders}
              columns={orderColumns}
              getRowId={(order) => order.id}
              isLoading={orders.isLoading}
              pageSize={8}
              emptyTitle="No orders yet"
              emptyDescription="Orders will appear here as customers place them."
            />
          </div>
        </AdminCard>
      </div>

      {/* --------------------------------------------------- top products */}
      <div className="mt-4">
        <AdminCard title="Top selling products" description="By revenue in the selected range">
          {snapshot === null ? (
            <div className="h-40 animate-pulse rounded-[3px] bg-admin-raised" />
          ) : snapshot.topProducts.length === 0 ? (
            <p className="py-6 text-center text-xs text-admin-muted">
              No sales in this period yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-admin-border">
                    <th scope="col" className="pb-2 text-left label-wide font-medium text-admin-muted">
                      Product
                    </th>
                    <th scope="col" className="pb-2 text-left label-wide font-medium text-admin-muted">
                      Category
                    </th>
                    <th scope="col" className="pb-2 text-right label-wide font-medium text-admin-muted">
                      Units
                    </th>
                    <th scope="col" className="pb-2 text-right label-wide font-medium text-admin-muted">
                      Revenue
                    </th>
                    <th scope="col" className="pb-2 text-right label-wide font-medium text-admin-muted">
                      Stock
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.topProducts.map((product) => (
                    <tr key={product.productId} className="border-b border-admin-border last:border-0">
                      <td className="py-2.5">
                        <Link
                          href={`/admin/products/edit?id=${product.productId}`}
                          className="text-xs text-admin-ink hover:text-copper-700"
                        >
                          {product.name}
                        </Link>
                      </td>
                      <td className="py-2.5 text-xs text-admin-muted">
                        {humanize(product.category)}
                      </td>
                      <td className="py-2.5 text-right text-xs tabular-nums">{product.unitsSold}</td>
                      <td className="py-2.5 text-right text-xs font-medium tabular-nums">
                        {formatPrice(product.revenue)}
                      </td>
                      <td className="py-2.5 text-right text-xs tabular-nums">
                        <span className={product.stock <= 8 ? "text-[#8a5d00]" : "text-admin-muted"}>
                          {product.stock}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdminCard>
      </div>
    </div>
  );
}
