"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FileMinus, FileText, Undo2 } from "lucide-react";

import type { CreditNote, Invoice, Payment, Refund } from "@/types";

import { AdminButton, AdminButtonLink, AdminCard } from "@/components/admin/ui/AdminChrome";
import { BillingBreakdownRows, GrandTotalRow } from "@/components/billing/BillingBreakdownRows";
import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { CreateCreditNoteDialog } from "@/components/admin/views/CreateCreditNoteDialog";
import { CreateRefundDialog } from "@/components/admin/views/CreateRefundDialog";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { getCreditNotesForOrder } from "@/services/billing/creditNoteService";
import { amountDue, getInvoiceByOrderId } from "@/services/billing/invoiceService";
import { getPaymentByOrderId, paymentMethodLabel } from "@/services/billing/paymentService";
import { getRefundsForOrder } from "@/services/billing/refundService";

/**
 * Billing, on the order page.
 *
 * An administrator looking at an order should not have to go somewhere else to
 * find out whether it was paid for. Everything the billing module knows about
 * this order is here — invoice, payment, refunds, credit notes — with the
 * actions that change any of it, and links through to the full records when the
 * answer needs more than a summary.
 *
 * Reloaded wholesale after an action, for the same reason the invoice page is:
 * a refund moves four records at once, and patching them separately is four
 * chances to show a figure that does not reconcile.
 */
export function OrderBillingPanel({ orderId }: { orderId: string }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [creditNotes, setCreditNotes] = useState<CreditNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [refundOpen, setRefundOpen] = useState(false);
  const [creditNoteOpen, setCreditNoteOpen] = useState(false);

  const load = useCallback(async () => {
    const [invoiceRecord, paymentRecord, refundList, noteList] = await Promise.all([
      getInvoiceByOrderId(orderId),
      getPaymentByOrderId(orderId),
      getRefundsForOrder(orderId),
      getCreditNotesForOrder(orderId),
    ]);

    setInvoice(invoiceRecord);
    setPayment(paymentRecord);
    setRefunds(refundList);
    setCreditNotes(noteList);
    setIsLoading(false);
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (isLoading) {
    return (
      <AdminCard title="Billing">
        <p className="py-6 text-center text-xs text-admin-muted">Loading…</p>
      </AdminCard>
    );
  }

  /**
   * An order without an invoice.
   *
   * Real for cancelled orders, which are never billed, and for orders placed
   * before billing existed. Saying so is more useful than an empty panel.
   */
  if (!invoice) {
    return (
      <AdminCard title="Billing">
        <p className="py-6 text-center text-xs text-admin-muted">
          No invoice was raised for this order. Cancelled orders are not billed.
        </p>
      </AdminCard>
    );
  }

  const due = amountDue(invoice);

  return (
    <>
      <AdminCard
        title="Billing"
        description="Invoice, payment and anything returned."
        action={
          <Link
            href={`/admin/billing/invoices/detail?id=${invoice.id}`}
            className="text-[0.6875rem] font-medium text-copper-700 hover:text-admin-ink"
          >
            Open invoice
          </Link>
        }
      >
        <div className="flex flex-col gap-4">
          {/* -------------------------------------------------------- invoice */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[3px] border border-admin-border bg-admin-raised px-3 py-2.5">
            <span className="flex min-w-0 items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0 text-admin-faint" strokeWidth={1.75} aria-hidden="true" />
              <Link
                href={`/admin/billing/invoices/detail?id=${invoice.id}`}
                className="truncate text-xs font-medium tabular-nums text-admin-ink hover:text-copper-700"
              >
                {invoice.invoiceNumber}
              </Link>
              <span className="shrink-0 text-[0.625rem] text-admin-faint">
                {formatDate(invoice.issuedAt)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <BillingStatusBadge domain="invoice" status={invoice.status} />
              <BillingStatusBadge domain="payment" status={invoice.paymentStatus} />
            </span>
          </div>

          {/* ------------------------------------------------------ breakdown */}
          <div>
            <BillingBreakdownRows breakdown={invoice.breakdown} detailed tone="admin" />
            <GrandTotalRow breakdown={invoice.breakdown} tone="admin" className="mt-3" />
            {due > 0 ? (
              <p className="mt-2 text-right text-[0.6875rem] text-status-serious tabular-nums">
                {formatMoney(due)} outstanding
              </p>
            ) : null}
          </div>

          {/* -------------------------------------------------------- payment */}
          <dl className="grid gap-x-6 gap-y-2 border-t border-admin-border pt-3 text-xs sm:grid-cols-2">
            {payment ? (
              <>
                <Row
                  label="Transaction"
                  value={
                    <Link
                      href={`/admin/billing/payments/detail?id=${payment.id}`}
                      className="text-copper-700 hover:text-admin-ink"
                    >
                      {payment.transactionId}
                    </Link>
                  }
                />
                <Row
                  label="Method"
                  value={`${paymentMethodLabel(payment.method)} · ${payment.instrumentHint}`}
                />
              </>
            ) : (
              <Row label="Payment" value="No payment record" />
            )}
            <Row label="Place of supply" value={invoice.placeOfSupply} />
            <Row
              label="Billing address"
              value={
                invoice.billingAddress.line1 === invoice.shippingAddress.line1
                  ? "Same as delivery"
                  : `${invoice.billingAddress.city}, ${invoice.billingAddress.state}`
              }
            />
          </dl>

          {/* ------------------------------------------- refunds + credit notes */}
          {refunds.length > 0 || creditNotes.length > 0 ? (
            <div className="grid gap-4 border-t border-admin-border pt-3 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
                  Refunds ({refunds.length})
                </p>
                {refunds.length === 0 ? (
                  <p className="text-xs text-admin-faint">None.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {refunds.map((refund) => (
                      <li key={refund.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-admin-muted">{refund.refundNumber}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="tabular-nums text-admin-ink">
                            {formatMoney(refund.amount)}
                          </span>
                          <BillingStatusBadge domain="refund" status={refund.status} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="mb-2 text-[0.625rem] font-medium uppercase tracking-[0.1em] text-admin-muted">
                  Credit notes ({creditNotes.length})
                </p>
                {creditNotes.length === 0 ? (
                  <p className="text-xs text-admin-faint">None.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {creditNotes.map((note) => (
                      <li key={note.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate text-admin-muted">{note.creditNoteNumber}</span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="tabular-nums text-admin-ink">
                            {formatMoney(note.total)}
                          </span>
                          <BillingStatusBadge domain="credit-note" status={note.status} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}

          {/* -------------------------------------------------------- actions */}
          <div className="flex flex-wrap gap-2 border-t border-admin-border pt-3">
            <AdminButton
              size="sm"
              variant="ghost"
              onClick={() => setRefundOpen(true)}
              disabled={!payment}
            >
              <Undo2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              Refund
            </AdminButton>
            <AdminButton size="sm" variant="ghost" onClick={() => setCreditNoteOpen(true)}>
              <FileMinus className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              Credit note
            </AdminButton>
            {payment ? (
              <AdminButtonLink
                size="sm"
                variant="ghost"
                href={`/admin/billing/payments/detail?id=${payment.id}`}
              >
                View payment
              </AdminButtonLink>
            ) : null}
          </div>
        </div>
      </AdminCard>

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
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-admin-faint">{label}</dt>
      <dd className="mt-0.5 text-admin-ink">{value}</dd>
    </div>
  );
}
