"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Link2, Loader2, Package, Truck } from "lucide-react";

import {
  AdminButton,
  AdminButtonLink,
  AdminCard,
  AdminPageHeader,
} from "@/components/admin/ui/AdminChrome";
import { DomainStatus, humanStatus } from "@/components/admin/ui/StatusBadge";
import { OrderBillingPanel } from "@/components/admin/views/OrderBillingPanel";
import { OrderRefundsCard } from "@/components/admin/views/refunds/OrderRefundsCard";
import { FulfilmentHistory } from "@/components/admin/views/fulfilment/FulfilmentHistory";
import { OrderFulfilmentPanel } from "@/components/admin/views/fulfilment/OrderFulfilmentPanel";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { stageLabel } from "@/lib/orders/orderFlow";
import { getOrderFulfilment } from "@/services/admin/fulfilmentAdminService";
import {
  canSendPaymentLink,
  getOrder,
  sendPaymentLink,
} from "@/services/admin/orderAdminService";
import { toast } from "@/store/toastStore";
import { paymentMethodLabel } from "@/services/billing/paymentService";

/**
 * One order in full, and where it is in fulfilment.
 *
 * There is no status dropdown. The fulfilment panel shows the lifecycle and
 * the next valid actions the server allows for this order and this admin
 * (docs/order-fulfilment.md): an order can't skip packing, be shipped without
 * a shipment, or step back without a reason. The history below is
 * append-only, across the order, its packing and its shipments.
 */
export function AdminOrderDetailView() {
  const searchParams = useSearchParams();
  const orderId = searchParams?.get("id") ?? "";

  const {
    data: order,
    isLoading,
    reload,
  } = useAdminResource(
    () => (orderId ? getOrder(orderId) : Promise.resolve(null)),
    [orderId],
  );

  // The lifecycle, next actions and history: read again after every change.
  const fulfilment = useAdminResource(
    () => (orderId ? getOrderFulfilment(orderId) : Promise.resolve(null)),
    [orderId],
  );
  // Bumped after a refund, so the billing figures are read again.
  const [billingKey, setBillingKey] = useState(0);
  const [sendingLink, setSendingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2
          className="h-5 w-5 animate-spin text-admin-faint"
          aria-label="Loading order"
        />
      </div>
    );
  }

  if (!order) {
    return (
      <div>
        <AdminPageHeader
          title="Order not found"
          breadcrumbs={[
            { label: "Admin", href: "/admin/dashboard" },
            { label: "Orders", href: "/admin/orders" },
            { label: "Not found" },
          ]}
        />
        <div className="rounded-[3px] border border-admin-border bg-admin-surface p-8 text-center">
          <p className="text-sm text-admin-ink">
            We couldn&rsquo;t find this order.
          </p>
          <AdminButtonLink
            href="/admin/orders"
            variant="secondary"
            className="mt-5"
          >
            Back to orders
          </AdminButtonLink>
        </div>
      </div>
    );
  }

  /** After any step: the order, its fulfilment and its billing, all from the server again. */
  const refreshAll = async () => {
    await Promise.all([reload(), fulfilment.reload()]);
    setBillingKey((value) => value + 1);
  };

  const onSendPaymentLink = async () => {
    setSendingLink(true);
    const result = await sendPaymentLink(order.id);
    setSendingLink(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    setLinkUrl(result.data.shortUrl);
    toast.success(`Payment request sent to ${order.customerName}`);
    await reload();
  };

  return (
    <div>
      <AdminPageHeader
        title={`Order #${order.orderNumber}`}
        description={`Placed ${formatDate(order.placedAt)} by ${order.customerName}`}
        breadcrumbs={[
          { label: "Admin", href: "/admin/dashboard" },
          { label: "Orders", href: "/admin/orders" },
          { label: `#${order.orderNumber}` },
        ]}
        actions={
          <span className="flex items-center gap-2">
            <DomainStatus domain="payment" status={order.paymentStatus} />
            <DomainStatus domain="order" status={order.status} label={stageLabel(order.status)} />
          </span>
        }
      />

      {/* --------------------------------------------- lifecycle + next step */}
      <OrderFulfilmentPanel
        orderId={order.id}
        data={fulfilment.data}
        loading={fulfilment.isLoading}
        failed={Boolean(fulfilment.error)}
        onRetry={() => void fulfilment.reload()}
        onChanged={refreshAll}
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          {/* --------------------------------------------------------- items */}
          <AdminCard
            title={`${order.lines.length} ${order.lines.length === 1 ? "item" : "items"}`}
          >
            <ul className="flex flex-col divide-y divide-admin-border">
              {order.lines.map((line, index) => (
                <li
                  key={`${line.productId}-${line.size ?? ""}-${index}`}
                  className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <span className="h-14 w-11 shrink-0 overflow-hidden rounded-[2px] bg-admin-raised">
                    {line.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={line.image}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : null}
                  </span>

                  <span className="min-w-0 flex-1">
                    <Link
                      href={`/admin/products/edit?id=${line.productId}`}
                      className="block truncate text-xs font-medium text-admin-ink hover:text-copper-700"
                    >
                      {line.name}
                    </Link>
                    <span className="block text-[0.625rem] text-admin-faint">
                      {line.sku}
                    </span>
                    {line.bundleName ? (
                      <span className="block text-[0.625rem] text-copper-700">Bundle: {line.bundleName} × {line.bundleQuantity}</span>
                    ) : line.flashSaleId ? (
                      <span className="block text-[0.625rem] text-copper-700">Flash sale price (regular {line.regularUnitPrice})</span>
                    ) : null}
                    <span className="mt-0.5 block text-[0.625rem] text-admin-muted">
                      {[line.size ? `Size ${line.size}` : null, line.color]
                        .filter(Boolean)
                        .join(" · ")}
                      {line.size || line.color ? " · " : ""}
                      {formatPrice(line.unitPrice)} × {line.quantity}
                    </span>
                  </span>

                  <span className="shrink-0 text-xs font-medium tabular-nums">
                    {formatPrice(line.lineTotal)}
                  </span>
                </li>
              ))}
            </ul>

            {/* ------------------------------------------------------ totals */}
            <dl className="mt-4 flex flex-col gap-1.5 border-t border-admin-border pt-4 text-xs">
              <Row
                label="Subtotal"
                value={formatPrice(order.totals.subtotal)}
              />
              {order.totals.catalogueSavings > 0 ? (
                <Row
                  label="Catalogue savings"
                  value={`− ${formatPrice(order.totals.catalogueSavings)}`}
                  positive
                />
              ) : null}
              {order.totals.couponDiscount > 0 ? (
                <Row
                  label={`Coupon${order.totals.appliedCoupon ? ` (${order.totals.appliedCoupon.code})` : ""}`}
                  value={`− ${formatPrice(order.totals.couponDiscount)}`}
                  positive
                />
              ) : null}
              {(order.totals.memberDiscount ?? 0) > 0 ? (
                <Row
                  label="Member savings"
                  value={`− ${formatPrice(order.totals.memberDiscount ?? 0)}`}
                  positive
                />
              ) : null}
              <Row
                label="Delivery"
                value={
                  order.totals.deliveryFee === 0
                    ? "Free"
                    : formatPrice(order.totals.deliveryFee)
                }
              />
              <Row
                // Rates differ by item (GST slabs); the invoice below breaks it down.
                label="Tax included"
                value={formatPrice(order.totals.taxAmount)}
                muted
              />

              <div className="mt-2 flex items-baseline justify-between border-t border-admin-border pt-2.5">
                <dt className="text-sm font-semibold text-admin-ink">Total</dt>
                <dd className="text-sm font-semibold text-admin-ink tabular-nums">
                  {formatPrice(order.totals.total)}
                </dd>
              </div>
            </dl>
          </AdminCard>

          {/* ------------------------------------------------------- billing */}
          <OrderBillingPanel key={billingKey} orderId={order.id} />
          <OrderRefundsCard orderId={order.id} onChanged={() => { setBillingKey((value) => value + 1); void reload(); }} />

          {/* ------------------------------------------------------ history */}
          {fulfilment.data ? (
            <FulfilmentHistory entries={fulfilment.data.history} />
          ) : (
            <AdminCard title="Timeline" description="Every update to this order.">
              <ol className="flex flex-col gap-3">
                {[...order.timeline].reverse().map((event, index) => (
                  <li key={`${event.status}-${event.at}-${index}`} className="flex gap-2.5">
                    <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill bg-copper-500" />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-admin-ink">{humanStatus(event.status)}</span>
                      <span className="block text-[0.625rem] text-admin-muted">
                        {formatDate(event.at)} · by {event.by}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </AdminCard>
          )}
        </div>

        {/* -------------------------------------------------- side column */}
        <div className="flex flex-col gap-4">
          <AdminCard title="Customer">
            <p className="text-xs font-medium text-admin-ink">
              {order.customerName}
            </p>
            <p className="mt-0.5 break-words text-[0.6875rem] text-admin-muted">
              {order.customerEmail}
            </p>
            <Link
              href={`/admin/customers/detail?id=${order.customerId}`}
              className="mt-2 inline-block text-[0.6875rem] font-medium text-copper-700 hover:text-admin-ink"
            >
              View customer
            </Link>
          </AdminCard>

          <AdminCard title="Shipping address">
            <address className="text-xs not-italic leading-relaxed text-admin-muted">
              <span className="block font-medium text-admin-ink">
                {order.shippingAddress.fullName}
              </span>
              {order.shippingAddress.line1}
              {order.shippingAddress.line2
                ? `, ${order.shippingAddress.line2}`
                : ""}
              <br />
              {order.shippingAddress.city}, {order.shippingAddress.state}{" "}
              {order.shippingAddress.pincode}
              <br />
              +91 {order.shippingAddress.phone}
            </address>
          </AdminCard>

          <AdminCard title="Payment & delivery">
            <dl className="flex flex-col gap-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-admin-muted">Method</dt>
                <dd className="text-admin-ink">
                  {paymentMethodLabel(order.paymentMethod)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-admin-muted">Payment</dt>
                <dd>
                  <DomainStatus domain="payment" status={order.paymentStatus} />
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-admin-muted">
                  <Truck
                    className="h-3 w-3"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  Tracking
                </dt>
                <dd className="text-right text-admin-ink">
                  {order.trackingNumber ? (
                    <span className="font-mono text-[0.625rem]">
                      {order.trackingNumber}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-admin-faint">
                      <Package
                        className="h-3 w-3"
                        strokeWidth={1.75}
                        aria-hidden="true"
                      />
                      Not shipped
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            {canSendPaymentLink(order) ? (
              <div className="mt-4 border-t border-admin-border pt-4">
                <p className="mb-3 text-[0.6875rem] leading-relaxed text-admin-muted">
                  We email the customer (and text them, if SMS is switched on
                  for payments) a link to pay now instead of in cash, on this
                  store&rsquo;s own payment page. The order is marked paid only
                  when the payment is confirmed. You can send it again.
                </p>
                <AdminButton
                  variant="secondary"
                  onClick={() => void onSendPaymentLink()}
                  loading={sendingLink}
                >
                  <Link2
                    className="h-3.5 w-3.5"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  Ask to pay online
                </AdminButton>
                {linkUrl ? (
                  <p className="mt-2 break-all text-[0.6875rem] text-admin-muted">
                    Sent:{" "}
                    <a
                      href={linkUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-copper-700 hover:text-admin-ink"
                    >
                      {linkUrl}
                    </a>
                  </p>
                ) : null}
              </div>
            ) : null}
          </AdminCard>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  positive,
  muted,
}: {
  label: string;
  value: string;
  positive?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-admin-muted">{label}</dt>
      <dd
        className={cn(
          "tabular-nums",
          positive
            ? "text-[#0a6b0a]"
            : muted
              ? "text-admin-faint"
              : "text-admin-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
