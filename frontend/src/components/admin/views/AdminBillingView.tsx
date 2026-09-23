"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import type { BillingStats, Invoice, Payment, Refund, TaxReportRow } from "@/types";

import { AdminButtonLink, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { BarList } from "@/components/admin/charts/BarList";
import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatMoney } from "@/lib/money";
import { formatCompactINR, formatDate } from "@/lib/utils/format";
import { getInvoices } from "@/services/billing/invoiceService";
import { getPayments, paymentMethodLabel } from "@/services/billing/paymentService";
import { getRefunds } from "@/services/billing/refundService";
import { billingDataSource } from "@/services/billing/billing-data-source.instance";

/**
 * The billing dashboard.
 *
 * Answers the question an owner actually opens it with: how much was invoiced,
 * how much of it arrived, and what is still outstanding. Every figure is
 * recomputed from the records on load — a stored total is a total that is wrong
 * the moment someone marks an invoice paid.
 */

type Range = "30d" | "3m" | "1y" | "all";

const RANGES: { id: Range; label: string; days: number | null }[] = [
  { id: "30d", label: "30D", days: 30 },
  { id: "3m", label: "3M", days: 90 },
  { id: "1y", label: "1Y", days: 365 },
  { id: "all", label: "All", days: null },
];

export function AdminBillingView() {
  const [range, setRange] = useState<Range>("30d");

  /**
   * "Now", captured once per mount.
   *
   * Reading the clock inside the memo would make it impure and let the window
   * drift while the page is open — the same reason the orders list does this.
   */
  const [now] = useState(() => Date.now());

  const from = useMemo(() => {
    const days = RANGES.find((entry) => entry.id === range)?.days ?? null;
    return days === null ? undefined : new Date(now - days * 86400000).toISOString();
  }, [range, now]);

  const { data: stats, isLoading } = useAdminResource<BillingStats>(
    () => billingDataSource.getStats(from),
    [from],
  );
  const { data: taxRows } = useAdminResource<TaxReportRow[]>(
    () => billingDataSource.getTaxReport(from),
    [from],
  );
  const { data: invoices } = useAdminResource<Invoice[]>(() => getInvoices(), []);
  const { data: payments } = useAdminResource<Payment[]>(() => getPayments(), []);
  const { data: refunds } = useAdminResource<Refund[]>(() => getRefunds(), []);

  const recentInvoices = (invoices ?? []).slice(0, 8);
  const openRefunds = (refunds ?? []).filter((refund) => refund.status !== "completed" && refund.status !== "rejected");

  /** Payments grouped by method — where the money actually comes in. */
  const byMethod = useMemo(() => {
    const totals = new Map<string, number>();
    for (const payment of payments ?? []) {
      if (payment.status === "failed") continue;
      const key = paymentMethodLabel(payment.method);
      totals.set(key, (totals.get(key) ?? 0) + payment.amount);
    }
    return [...totals.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  }, [payments]);

  return (
    <div>
      <AdminPageHeader
        title="Billing"
        description="Invoiced, collected and outstanding — with what has gone back out."
        breadcrumbs={[{ label: "Admin", href: "/admin/dashboard" }, { label: "Billing" }]}
        actions={
          <div className="flex items-center gap-1 rounded-[3px] border border-admin-border bg-admin-surface p-0.5">
            {RANGES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setRange(entry.id)}
                aria-pressed={range === entry.id}
                className={cn(
                  "rounded-[2px] px-2.5 py-1 text-[0.6875rem] font-medium transition-colors",
                  range === entry.id
                    ? "bg-admin-ink text-white"
                    : "text-admin-muted hover:bg-admin-raised hover:text-admin-ink",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
        }
      />

      {/* ------------------------------------------------------------ KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Revenue" value={stats?.revenue} loading={isLoading} emphasis />
        <Kpi label="Paid" value={stats?.paid} loading={isLoading} tone="good" />
        <Kpi label="Pending" value={stats?.pending} loading={isLoading} tone="warning" />
        <Kpi label="Refunded" value={stats?.refunded} loading={isLoading} tone="critical" />
        <Kpi label="Tax collected" value={stats?.taxCollected} loading={isLoading} />
        <Kpi
          label="Invoices"
          value={stats?.invoiceCount}
          loading={isLoading}
          isCount
          href="/admin/billing/invoices"
        />
      </div>

      {/* ---------------------------------------------------------- charts */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <AdminCard
          title="Collected by payment method"
          description="Successful and pending payments, by how they were taken."
        >
          {byMethod.length === 0 ? (
            <p className="py-8 text-center text-xs text-admin-muted">No payments in range.</p>
          ) : (
            <BarList
              data={byMethod}
              scale="nominal"
              valueFormat={(value) => formatCompactINR(value / 100)}
            />
          )}
        </AdminCard>

        <AdminCard title="Tax collected by rate" description="Grouped the way a return is filed.">
          {!taxRows || taxRows.length === 0 ? (
            <p className="py-8 text-center text-xs text-admin-muted">Nothing to report.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[24rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-admin-border text-left">
                    <Th>Rate</Th>
                    <Th align="right">Taxable value</Th>
                    <Th align="right">CGST</Th>
                    <Th align="right">SGST</Th>
                    <Th align="right">IGST</Th>
                    <Th align="right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {taxRows.map((row) => (
                    <tr key={row.ratePercent} className="border-b border-admin-border last:border-0">
                      <td className="py-2 text-xs tabular-nums text-admin-ink">{row.ratePercent}%</td>
                      <Td>{formatMoney(row.taxableAmount, { showDecimals: true })}</Td>
                      <Td>{formatMoney(row.cgst, { showDecimals: true })}</Td>
                      <Td>{formatMoney(row.sgst, { showDecimals: true })}</Td>
                      <Td>{formatMoney(row.igst, { showDecimals: true })}</Td>
                      <Td strong>{formatMoney(row.totalTax, { showDecimals: true })}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AdminCard>
      </div>

      {/* ---------------------------------------------------------- tables */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <AdminCard
          title="Recent invoices"
          description="The eight most recent, newest first."
          action={
            <AdminButtonLink href="/admin/billing/invoices" size="sm" variant="ghost">
              All invoices
            </AdminButtonLink>
          }
        >
          {recentInvoices.length === 0 ? (
            <p className="py-8 text-center text-xs text-admin-muted">No invoices yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-admin-border">
              {recentInvoices.map((invoice) => (
                <li key={invoice.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
                  <span className="min-w-0">
                    <Link
                      href={`/admin/billing/invoices/detail?id=${invoice.id}`}
                      className="block truncate text-xs font-medium text-admin-ink hover:text-copper-700"
                    >
                      {invoice.invoiceNumber}
                    </Link>
                    <span className="mt-0.5 block truncate text-[0.625rem] text-admin-faint">
                      {invoice.customerName} · {formatDate(invoice.issuedAt)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs font-medium tabular-nums text-admin-ink">
                      {formatMoney(invoice.breakdown.grandTotal)}
                    </span>
                    <BillingStatusBadge domain="invoice" status={invoice.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AdminCard>

        <AdminCard
          title="Refunds needing action"
          description="Requested or in progress."
          action={
            <AdminButtonLink href="/admin/billing/refunds" size="sm" variant="ghost">
              All refunds
            </AdminButtonLink>
          }
        >
          {openRefunds.length === 0 ? (
            <p className="py-8 text-center text-xs text-admin-muted">
              Nothing waiting. Every refund is settled.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-admin-border">
              {openRefunds.slice(0, 8).map((refund) => (
                <li key={refund.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0">
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-admin-ink">
                      {refund.refundNumber}
                    </span>
                    <span className="mt-0.5 block truncate text-[0.625rem] text-admin-faint">
                      {refund.customerName} · {refund.reason}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-xs font-medium tabular-nums text-admin-ink">
                      {formatMoney(refund.amount)}
                    </span>
                    <BillingStatusBadge domain="refund" status={refund.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AdminCard>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Kpi({
  label,
  value,
  loading,
  tone,
  emphasis,
  isCount,
  href,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  tone?: "good" | "warning" | "critical";
  emphasis?: boolean;
  isCount?: boolean;
  href?: string;
}) {
  const body = (
    <>
      <span className="block text-[0.625rem] font-medium uppercase tracking-[0.12em] text-admin-faint">
        {label}
      </span>
      <span
        className={cn(
          "mt-2 block tabular-nums",
          emphasis ? "text-xl font-semibold" : "text-lg font-medium",
          tone === "good"
            ? "text-status-good"
            : tone === "warning"
              ? "text-status-serious"
              : tone === "critical"
                ? "text-status-critical"
                : "text-admin-ink",
        )}
      >
        {loading || value === undefined
          ? "—"
          : isCount
            ? value.toLocaleString("en-IN")
            : formatMoney(value)}
      </span>
    </>
  );

  const className =
    "block rounded-[3px] border border-admin-border bg-admin-surface p-3 transition-colors";

  return href ? (
    <Link href={href} className={cn(className, "hover:border-admin-border-strong")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      scope="col"
      className={cn(
        "pb-2 text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <td
      className={cn(
        "py-2 text-right text-xs tabular-nums",
        strong ? "font-medium text-admin-ink" : "text-admin-muted",
      )}
    >
      {children}
    </td>
  );
}
