"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { CheckCircle2, Download, FileMinus, Mail, Printer, Undo2 } from "lucide-react";

import type { CreditNote, Invoice, Payment, Refund } from "@/types";

import { AdminButton, AdminCard, AdminPageHeader } from "@/components/admin/ui/AdminChrome";
import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { InvoiceDocument } from "@/components/billing/InvoiceDocument";
import { downloadInvoiceCsv, useInvoicePrint } from "@/components/billing/InvoiceActions";
import { CreateRefundDialog } from "@/components/admin/views/CreateRefundDialog";
import { CreateCreditNoteDialog } from "@/components/admin/views/CreateCreditNoteDialog";
import { Skeleton } from "@/components/ui/Skeleton";
import { useBillingConfig, useTaxConfig } from "@/hooks/useBillingConfig";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { getCreditNotesForOrder } from "@/services/billing/creditNoteService";
import { amountDue, getInvoiceById, markInvoicePaid } from "@/services/billing/invoiceService";
import { capturePayment, getPaymentById } from "@/services/billing/paymentService";
import { getRefundsForOrder } from "@/services/billing/refundService";
import { toast } from "@/store/toastStore";

/**
 * One invoice, with everything an administrator can do to it.
 *
 * The document itself is the same component the customer sees — an invoice the
 * two parties read differently is not a document of record. What differs is the
 * action bar above it and the related records beside it, so a question about an
 * invoice can be answered without leaving the page.
 */
function AdminInvoiceDetail() {
  const searchParams = useSearchParams();
  const id = searchParams?.get("id") ?? "";

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [refundOpen, setRefundOpen] = useState(false);
  const [creditNoteOpen, setCreditNoteOpen] = useState(false);

  const config = useBillingConfig();
  const taxConfig = useTaxConfig();
  const print = useInvoicePrint();

  /**
   * Load the invoice and everything that points at it.
   *
   * Re-run after any action rather than patching pieces of state: a refund
   * changes the payment, the invoice and the credit-note list at once, and
   * three separate optimistic updates is three chances to show a figure that
   * does not reconcile.
   */
  const load = useCallback(async () => {
    if (!id) {
      setIsLoading(false);
      return;
    }

    const found = await getInvoiceById(id);
    setInvoice(found);

    if (found) {
      const [paymentRecord, refundList, noteList] = await Promise.all([
        found.paymentId ? getPaymentById(found.paymentId) : Promise.resolve(null),
        getRefundsForOrder(found.orderId),
        getCreditNotesForOrder(found.orderId),
      ]);
      setPayment(paymentRecord);
      setRefunds(refundList);
      setCreditNotes(noteList);
    }

    setIsLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const onMarkPaid = async () => {
    if (!invoice) return;
    setBusy(true);
    await markInvoicePaid(invoice);
    if (payment && payment.status === "pending") await capturePayment(payment);
    await load();
    setBusy(false);
    toast.success(`${invoice.invoiceNumber} marked as paid`);
  };

  if (isLoading || !config) {
    return (
      <div>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-6 h-[40rem] w-full" />
      </div>
    );
  }

  if (!invoice) {
    return (
      <div>
        <AdminPageHeader
          title="Invoice not found"
          breadcrumbs={[
            { label: "Admin", href: "/admin/dashboard" },
            { label: "Billing", href: "/admin/billing" },
            { label: "Invoices", href: "/admin/billing/invoices" },
          ]}
        />
        <AdminCard>
          <p className="py-10 text-center text-sm text-admin-muted">
            No invoice with that reference. It may have been raised in a different browser —
            billing records are stored locally.
          </p>
        </AdminCard>
      </div>
    );
  }

  const due = amountDue(invoice);
  const settled = due <= 0;

  return (
    <div>
      <AdminPageHeader
        title={invoice.invoiceNumber}
        description={`Order ${invoice.orderNumber} · ${invoice.customerName} · ${formatDate(invoice.issuedAt)}`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Billing", href: "/admin/billing" },
          { label: "Invoices", href: "/admin/billing/invoices" },
          { label: invoice.invoiceNumber },
        ]}
        actions={
          <div className="flex flex-wrap gap-2">
            <BillingStatusBadge domain="invoice" status={invoice.status} />
            <BillingStatusBadge domain="payment" status={invoice.paymentStatus} />
          </div>
        }
      />

      {/* ----------------------------------------------------------- actions */}
      <div className="print-hidden mb-4 flex flex-wrap gap-2">
        <AdminButton size="sm" variant="secondary" onClick={print}>
          <Printer className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
          Print
        </AdminButton>

        <AdminButton
          size="sm"
          variant="secondary"
          onClick={() => {
            downloadInvoiceCsv(invoice);
            toast.success(`${invoice.invoiceNumber} downloaded`);
          }}
        >
          <Download className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
          Download
        </AdminButton>

        <AdminButton
          size="sm"
          variant="ghost"
          onClick={() =>
            // No mail is sent and none can be: there is no server to send it.
            // Saying so is better than a button that pretends.
            toast.info(
              `Sending is not wired up yet — it needs a backend. ${invoice.customerEmail} would receive this invoice.`,
            )
          }
        >
          <Mail className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
          Send invoice
        </AdminButton>

        {!settled ? (
          <AdminButton size="sm" variant="primary" onClick={onMarkPaid} disabled={busy}>
            <CheckCircle2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
            Mark as paid
          </AdminButton>
        ) : null}

        <AdminButton
          size="sm"
          variant="ghost"
          onClick={() => setRefundOpen(true)}
          disabled={busy || !payment}
        >
          <Undo2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
          Create refund
        </AdminButton>

        <AdminButton size="sm" variant="ghost" onClick={() => setCreditNoteOpen(true)} disabled={busy}>
          <FileMinus className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
          Create credit note
        </AdminButton>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        {/* -------------------------------------------------------- document */}
        <div className="min-w-0 overflow-hidden rounded-[3px] border border-admin-border bg-white">
          <InvoiceDocument invoice={invoice} config={config} gstin={taxConfig?.gstin ?? ""} />
        </div>

        {/* --------------------------------------------------------- related */}
        <div className="print-hidden flex flex-col gap-4">
          <AdminCard title="Settlement">
            <dl className="flex flex-col gap-2 text-xs">
              <Row label="Invoiced" value={formatMoney(invoice.breakdown.grandTotal)} />
              <Row label="Paid" value={formatMoney(invoice.amountPaid)} />
              {invoice.amountRefunded > 0 ? (
                <Row label="Refunded" value={`− ${formatMoney(invoice.amountRefunded)}`} />
              ) : null}
              <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-admin-border pt-2">
                <dt className="font-medium text-admin-ink">Outstanding</dt>
                <dd className="font-semibold tabular-nums text-admin-ink">{formatMoney(due)}</dd>
              </div>
            </dl>
          </AdminCard>

          <AdminCard title="Payment">
            {payment ? (
              <dl className="flex flex-col gap-2 text-xs">
                <Row
                  label="Transaction"
                  value={
                    <Link
                      href={`/admin/billing/payments/detail?id=${payment.id}`}
                      className="tabular-nums text-copper-700 hover:text-admin-ink"
                    >
                      {payment.transactionId}
                    </Link>
                  }
                />
                <Row label="Method" value={payment.instrumentHint || payment.method} />
                <Row label="Provider" value={payment.provider} />
                <Row label="Status" value={<BillingStatusBadge domain="payment" status={payment.status} />} />
              </dl>
            ) : (
              <p className="py-4 text-center text-xs text-admin-muted">
                No payment record for this invoice.
              </p>
            )}
          </AdminCard>

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
                        {refund.reason}
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
          </AdminCard>

          <AdminCard title={`Credit notes (${creditNotes.length})`}>
            {creditNotes.length === 0 ? (
              <p className="py-4 text-center text-xs text-admin-muted">None issued.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-admin-border">
                {creditNotes.map((note) => (
                  <li key={note.id} className="flex items-center justify-between gap-2 py-2 first:pt-0">
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-admin-ink">
                        {note.creditNoteNumber}
                      </span>
                      <span className="block truncate text-[0.625rem] text-admin-faint">
                        {formatDate(note.issuedAt)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="text-xs tabular-nums text-admin-ink">
                        {formatMoney(note.total)}
                      </span>
                      <BillingStatusBadge domain="credit-note" status={note.status} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </AdminCard>
        </div>
      </div>

      <CreateRefundDialog
        open={refundOpen}
        onOpenChange={setRefundOpen}
        invoice={invoice}
        payment={payment}
        onDone={load}
      />

      <CreateCreditNoteDialog
        open={creditNoteOpen}
        onOpenChange={setCreditNoteOpen}
        invoice={invoice}
        onDone={load}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-admin-muted">{label}</dt>
      <dd className="shrink-0 tabular-nums text-admin-ink">{value}</dd>
    </div>
  );
}

export function AdminInvoiceDetailView() {
  return (
    <Suspense fallback={<Skeleton className="h-[40rem] w-full" />}>
      <AdminInvoiceDetail />
    </Suspense>
  );
}
