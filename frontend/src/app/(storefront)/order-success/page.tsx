"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Check, FileText, Package, Truck } from "lucide-react";

import type { Invoice, Order } from "@/types";

import { ProductImage } from "@/components/common/ProductImage";
import { EmptyState } from "@/components/common/States";
import { ButtonLink } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { BillingStatusBadge } from "@/components/billing/BillingStatusBadge";
import { formatMoney } from "@/lib/money";
import { getInvoiceById } from "@/services/billing/invoiceService";
import { getOrder } from "@/services/orderService";
import { formatDate, formatPrice } from "@/lib/utils/format";

/**
 * Order confirmation.
 *
 * Reads the order number from the URL and looks the order up, so the page is
 * refreshable and shareable rather than depending on transient state that
 * vanishes on reload.
 */
function OrderSuccess() {
  const searchParams = useSearchParams();
  const orderNumber = searchParams?.get("order") ?? "";

  const invoiceId = searchParams?.get("invoice") ?? "";

  const [order, setOrder] = useState<Order | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!orderNumber) {
      setIsLoading(false);
      return;
    }

    let active = true;
    getOrder(orderNumber)
      .then((result) => {
        if (active) setOrder(result);
      })
      .catch(() => {
        if (active) setOrder(null);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [orderNumber]);

  /**
   * The invoice raised for this order.
   *
   * Looked up separately so a confirmation still renders if the invoice is
   * missing — an order that exists without its invoice is a problem to fix,
   * not a reason to show the shopper nothing.
   */
  useEffect(() => {
    if (!invoiceId) return;
    let active = true;
    getInvoiceById(invoiceId)
      .then((result) => {
        if (active) setInvoice(result);
      })
      .catch(() => {
        if (active) setInvoice(null);
      });
    return () => {
      active = false;
    };
  }, [invoiceId]);

  if (isLoading) {
    return (
      <div className="page-shell max-w-2xl py-16">
        <Skeleton className="mx-auto h-14 w-14 rounded-pill" />
        <Skeleton className="mx-auto mt-6 h-8 w-64" />
        <Skeleton className="mx-auto mt-3 h-4 w-80" />
        <Skeleton className="mt-10 h-64 w-full" />
      </div>
    );
  }

  if (!order) {
    return (
      <EmptyState
        title="We could not find that order"
        description="The order number may be wrong, or it was placed in a different browser. Sample orders are stored locally on the device that placed them."
        action={{ label: "Back to shopping", href: "/shop" }}
      />
    );
  }

  return (
    <div className="page-shell py-12 sm:py-16">
      <div className="mx-auto max-w-2xl">
        {/* -------------------------------------------------- confirmation */}
        <div className="text-center">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-pill bg-sage-100">
            <Check className="h-6 w-6 text-sage-600" strokeWidth={2} aria-hidden="true" />
          </span>

          <h1 className="mt-6 font-display text-2xl leading-tight text-ink sm:text-3xl">
            Thank you — your order is confirmed
          </h1>

          <p className="mt-3 text-sm leading-relaxed text-ink-500">
            We have emailed a confirmation to{" "}
            <span className="text-ink">{order.address.fullName}</span>. Your order number is{" "}
            <span className="font-medium text-ink">{order.orderNumber}</span>.
          </p>
        </div>

        {/* ----------------------------------------------------- key facts */}
        <dl className="mt-10 grid gap-4 sm:grid-cols-2">
          <div className="rounded-card border border-ink-200 bg-shell p-4">
            <dt className="label-wide flex items-center gap-2 text-ink-500">
              <Truck className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              Expected delivery
            </dt>
            <dd className="mt-2 text-sm text-ink">{order.expectedDelivery}</dd>
            <dd className="mt-0.5 text-xs text-ink-400">
              {order.deliveryMethod.name} · {order.deliveryMethod.estimate}
            </dd>
          </div>

          <div className="rounded-card border border-ink-200 bg-shell p-4">
            <dt className="label-wide flex items-center gap-2 text-ink-500">
              <Package className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              Order placed
            </dt>
            <dd className="mt-2 text-sm text-ink">{formatDate(order.placedAt)}</dd>
            <dd className="mt-0.5 text-xs text-ink-400">
              Paid by {order.paymentMethod.name.toLowerCase()}
            </dd>
          </div>
        </dl>

        {/* ------------------------------------------------------ invoice */}
        {invoice ? (
          <div className="mt-4 rounded-card border border-ink-200 bg-shell p-4">
            <h2 className="label-wide flex items-center gap-2 text-ink-500">
              <FileText className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              Invoice
            </h2>

            <dl className="mt-3 flex flex-wrap items-baseline gap-x-8 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-ink-400">Invoice number</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-ink">
                  {invoice.invoiceNumber}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-400">Amount</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-ink">
                  {formatMoney(invoice.breakdown.grandTotal)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-400">Payment status</dt>
                <dd className="mt-1">
                  <BillingStatusBadge domain="payment" status={invoice.paymentStatus} />
                </dd>
              </div>
            </dl>
          </div>
        ) : null}

        {/* -------------------------------------------------------- items */}
        <div className="mt-4 rounded-card border border-ink-200 bg-shell p-4">
          <h2 className="label-wide text-ink">
            {order.lines.length} {order.lines.length === 1 ? "item" : "items"}
          </h2>

          <ul className="mt-4 flex flex-col divide-y divide-ink-100">
            {order.lines.map((line, index) => (
              <li
                key={`${line.productId}-${line.size ?? ""}-${index}`}
                className="flex items-center gap-3.5 py-3 first:pt-0"
              >
                <Link href={`/product/${line.slug}`} className="shrink-0" tabIndex={-1}>
                  <ProductImage
                    src={line.image}
                    alt=""
                    sizes="64px"
                    wrapperClassName="h-20 w-16 rounded-card"
                  />
                </Link>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    <Link
                      href={`/product/${line.slug}`}
                      className="transition-colors hover:text-copper-700"
                    >
                      {line.name}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-xs text-ink-500">{line.brand}</p>
                  <p className="mt-1 text-xs text-ink-400">
                    {[line.size ? `Size ${line.size}` : null, line.color]
                      .filter(Boolean)
                      .join(" · ")}
                    {line.size || line.color ? " · " : ""}
                    Qty {line.quantity}
                  </p>
                </div>

                <p className="shrink-0 text-sm text-ink tabular-nums">
                  {formatPrice(line.lineTotal)}
                </p>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-baseline justify-between border-t border-ink-200 pt-4">
            <span className="text-sm font-medium text-ink">Total paid</span>
            <span className="font-display text-xl text-ink tabular-nums">
              {formatPrice(order.totals.total)}
            </span>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
          <ButtonLink href={`/account/order?number=${order.orderNumber}`} variant="outline">
            View order
          </ButtonLink>
          {invoice ? (
            <ButtonLink href={`/account/invoice?id=${invoice.id}`} variant="outline">
              View invoice
            </ButtonLink>
          ) : null}
          <ButtonLink href="/shop">Continue shopping</ButtonLink>
        </div>
      </div>
    </div>
  );
}

export default function OrderSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="page-shell max-w-2xl py-16">
          <Skeleton className="mx-auto h-14 w-14 rounded-pill" />
          <Skeleton className="mx-auto mt-6 h-8 w-64" />
        </div>
      }
    >
      <OrderSuccess />
    </Suspense>
  );
}
