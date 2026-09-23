"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { CheckCircle2, Undo2 } from "lucide-react";

import type { Invoice, Payment, Refund } from "@/types";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { CreateRefundDialog } from "@/components/admin/views/CreateRefundDialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { getInvoiceById } from "@/services/billing/invoiceService";
import {
  capturePayment,
  getPaymentById,
  paymentMethodLabel,
  refundableAmount,
} from "@/services/billing/paymentService";
import { getRefundsForOrder } from "@/services/billing/refundService";
import { toast } from "@/store/toastStore";

/**
 * One transaction, with its timeline.
 *
 * The timeline is append-only and is the record of what actually happened —
 * initiated, processing, then succeeded, failed or refunded. It is not derived
 * from the current status, because "it is refunded now" and "it was authorised,
 * captured, then refunded three days later" answer different questions, and
 * support needs the second one.
 */
function AdminPaymentDetail() {
  const searchParams = useSearchParams();
  const id = searchParams?.get("id") ?? "";

  const [payment, setPayment] = useState<Payment | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      setIsLoading(false);
      return;
    }

    const found = await getPaymentById(id);
    setPayment(found);

    if (found) {
      const [invoiceRecord, refundList] = await Promise.all([
        getInvoiceById(found.invoiceId),
        getRefundsForOrder(found.orderId),
      ]);
      setInvoice(invoiceRecord);
      setRefunds(refundList);
    }

    setIsLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (isLoading) {
    return (
      <div>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-6 h-96 w-full" />
      </div>
    );
  }

  if (!payment) {
    return (
      <div>
        <AdminPageHeader
          title="Payment not found"
          breadcrumbs={[
            { label: "Admin", href: "/admin/dashboard" },
            { label: "Billing", href: "/admin/billing" },
            { label: "Payments", href: "/admin/billing/payments" },
          ]}
        />
        <AdminCard>
          <p className="py-10 text-center text-sm text-admin-muted">
            No transaction with that reference.
          </p>
        </AdminCard>
      </div>
    );
  }

  const refundable = refundableAmount(payment);

  const onCapture = async () => {
    setBusy(true);
    await capturePayment(payment);
    await load();
    setBusy(false);
    toast.success("Payment marked as received");
  };

  return (
    <div>
      <AdminPageHeader
        title={payment.transactionId}
        description={`${paymentMethodLabel(payment.method)} · ${payment.customerName} · ${formatDate(payment.createdAt)}`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Billing", href: "/admin/billing" },
          { label: "Payments", href: "/admin/billing/payments" },
          { label: payment.transactionId },
        ]}
        actions={<BillingStatusBadge domain="payment" status={payment.status} />}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {payment.status === "pending" ? (
          <AdminButton size="sm" variant="primary" onClick={onCapture} disabled={busy}>
            <CheckCircle2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            Mark as received
          </AdminButton>
        ) : null}

        <AdminButton
          size="sm"
          variant="ghost"
          onClick={() => setRefundOpen(true)}
          disabled={busy || refundable <= 0 || !invoice}
        >
          <Undo2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
          Create refund
        </AdminButton>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <AdminCard title="Transaction">
            <dl className="grid gap-x-8 gap-y-3 text-xs sm:grid-cols-2">
              <Row label="Transaction ID" value={payment.transactionId} />
              <Row label="Payment ID" value={payment.id} />
              <Row
                label="Order"
                value={
                  <Link
                    href={`/admin/orders/detail?id=${payment.orderId}`}
                    className="text-copper-700 hover:text-admin-ink"
                  >
                    {payment.orderNumber}
                  </Link>
                }
              />
              <Row
                label="Invoice"
                value={
                  <Link
                    href={`/admin/billing/invoices/detail?id=${payment.invoiceId}`}
                    className="text-copper-700 hover:text-admin-ink"
                  >
                    {payment.invoiceNumber}
                  </Link>
                }
              />
              <Row
                label="Customer"
                value={
                  <Link
                    href={`/admin/customers/detail?id=${payment.customerId}`}
                    className="text-copper-700 hover:text-admin-ink"
                  >
                    {payment.customerName}
                  </Link>
                }
              />
              <Row label="Amount" value={formatMoney(payment.amount)} />
              <Row label="Refunded" value={formatMoney(payment.refundedAmount)} />
              <Row label="Method" value={`${paymentMethodLabel(payment.method)} · ${payment.instrumentHint}`} />
              <Row label="Provider" value={payment.provider} />
              <Row label="Created" value={formatDate(payment.createdAt)} />
              <Row label="Captured" value={payment.capturedAt ? formatDate(payment.capturedAt) : "Not captured"} />
            </dl>

            <p className="mt-4 border-t border-admin-border pt-3 text-[0.6875rem] leading-relaxed text-admin-faint">
              Only a masked remnant of the instrument is stored. No card number, expiry, CVV, UPI
              PIN or bank credential is collected anywhere in this application.
            </p>
          </AdminCard>

          <AdminCard title="Timeline" description="Append-only history of this transaction.">
            <ol className="flex flex-col gap-3">
              {[...payment.timeline].reverse().map((event, index) => (
                <li key={`${event.status}-${event.at}-${index}`} className="flex gap-3">
                  <span
                    className={
                      event.status === "failed"
                        ? "mt-1 h-2 w-2 shrink-0 rounded-pill bg-status-critical"
                        : event.status === "succeeded"
                          ? "mt-1 h-2 w-2 shrink-0 rounded-pill bg-status-good"
                          : event.status === "refunded"
                            ? "mt-1 h-2 w-2 shrink-0 rounded-pill bg-admin-border-strong"
                            : "mt-1 h-2 w-2 shrink-0 rounded-pill bg-chart-1"
                    }
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium capitalize text-admin-ink">
                      Payment {event.status}
                    </span>
                    <span className="block text-[0.625rem] text-admin-faint">
                      {formatDate(event.at)}
                    </span>
                    {event.note ? (
                      <span className="mt-0.5 block text-[0.6875rem] text-admin-muted">
                        {event.note}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          </AdminCard>
        </div>

        <AdminCard title={`Refunds (${refunds.length})`}>
          {refunds.length === 0 ? (
            <p className="py-4 text-center text-xs text-admin-muted">Nothing refunded.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-admin-border">
              {refunds.map((refund) => (
                <li key={refund.id} className="flex items-center justify-between gap-2 py-2 first:pt-0">
                  <span className="min-w-0">
                    <span className="block truncate text-xs text-admin-ink">{refund.refundNumber}</span>
                    <span className="block truncate text-[0.625rem] text-admin-faint">
                      {formatDate(refund.requestedAt)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs tabular-nums text-admin-ink">
                      {formatMoney(refund.amount)}
                    </span>
                    <BillingStatusBadge domain="refund" status={refund.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-3 border-t border-admin-border pt-3 text-[0.6875rem] text-admin-muted tabular-nums">
            {formatMoney(refundable)} still refundable.
          </p>
        </AdminCard>
      </div>

      {invoice ? (
        <CreateRefundDialog
          open={refundOpen}
          onOpenChange={setRefundOpen}
          invoice={invoice}
          payment={payment}
          onDone={load}
        />
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-admin-faint">{label}</dt>
      <dd className="mt-0.5 tabular-nums text-admin-ink">{value}</dd>
    </div>
  );
}

export function AdminPaymentDetailView() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <AdminPaymentDetail />
    </Suspense>
  );
}
