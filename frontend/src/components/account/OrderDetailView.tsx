"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertCircle, Check, FileText, LifeBuoy } from "lucide-react";

import type { Order } from "@/types";

import { AccountShell } from "@/components/account/AccountShell";
import { OrderReturns } from "@/components/account/OrderReturns";
import { ReorderDialog } from "@/components/account/ReorderDialog";
import {
  ORDER_TIMELINE,
  OrderStatusBadge,
  statusLabel,
} from "@/components/account/OrderStatusBadge";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/common/States";
import { ProductImage } from "@/components/common/ProductImage";
import { Skeleton } from "@/components/ui/Skeleton";
import { useSession } from "@/hooks/useSession";
import { cancelOrder, getOrder } from "@/services/orderService";
import { ApiError } from "@/services/api/client";
import { toast } from "@/store/toastStore";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";

/** A single order: status tracker, items, addresses and the money breakdown. */
export function OrderDetailView() {
  const [reorderKey, setReorderKey] = useState<string | null | undefined>(undefined);
  /**
   * The order number arrives as `?number=` rather than a path segment.
   *
   * A dynamic path segment cannot be statically exported — every value would
   * have to be known at build time, and order numbers are created at runtime.
   */
  const searchParams = useSearchParams();
  const orderNumber = (searchParams?.get("number") ?? "").trim();
  const { isSignedIn } = useSession();

  const [order, setOrder] = useState<Order | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  /**
   * Still owed for.
   *
   * The durable place to finish paying. The confirmation page offers this too,
   * but its URL is transient — this is where somebody comes back to two days
   * later, and an order they can see but cannot pay for is a dead end.
   *
   * Cash on delivery is excluded: it is unpaid by arrangement, and there is
   * nothing to pay online.
   */
  const awaitingPayment =
    order !== null &&
    // A cancelled order whose payment timed out owes nothing.
    order.status === "pending" &&
    Boolean(order.paymentId) &&
    order.paymentStatus !== "paid" &&
    order.paymentStatus !== "cod-pending" &&
    order.paymentStatus !== "refunded";
  // Cash on delivery: nothing is paid yet, and nothing is overdue either.
  const payOnDelivery =
    order?.paymentStatus === "cod-pending" && order.status !== "cancelled";
  const isPaid = order?.paymentStatus === "paid";
  // The same stages the server lets a customer cancel from — before dispatch.
  const canCancel =
    order !== null &&
    ["pending", "confirmed", "processing", "packed"].includes(order.status);

  const [confirmCancel, setConfirmCancel] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const onCancel = async () => {
    if (!order) return;
    setIsCancelling(true);
    try {
      setOrder(
        await cancelOrder(order.orderNumber, "Cancelled by the customer."),
      );
      setConfirmCancel(false);
      toast.success(
        isPaid
          ? "Order cancelled — your refund is on its way"
          : "Order cancelled",
      );
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.message
          ? error.message
          : "We couldn't cancel the order. Please try again.",
      );
    } finally {
      setIsCancelling(false);
    }
  };

  useEffect(() => {
    if (!isSignedIn || !orderNumber) return;
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
  }, [orderNumber, isSignedIn]);

  /**
   * Back to the payment step, rather than a payment window.
   *
   * The same page the checkout uses, so there is one payment interface in the
   * whole application. It reopens the same gateway order, so returning here
   * days later cannot produce a second charge.
   */
  const payHref = order?.paymentId
    ? `/checkout/payment?payment=${encodeURIComponent(order.paymentId)}`
    : "";

  return (
    <AccountShell
      title={isLoading || !order ? "Order" : order.orderNumber}
      breadcrumb={[
        { label: "Orders", href: "/account/orders" },
        { label: order?.orderNumber ?? orderNumber },
      ]}
    >
      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !order ? (
        <EmptyState
          title="Order not found"
          description="We could not find that order number on this account. It may have been placed from a different account."
          action={{ label: "Back to orders", href: "/account/orders" }}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {/* ------------------------------------------------------ header */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-500">
              Placed {formatDate(order.placedAt)} &middot;{" "}
              {awaitingPayment
                ? "Awaiting"
                : isPaid
                  ? "Paid by"
                  : payOnDelivery
                    ? "Paying by"
                    : "Method:"}{" "}
              {order.paymentMethod.name}
            </p>
            <div className="flex items-center gap-3">
              {order.status !== "pending" ? (
                <Button size="sm" variant="secondary" onClick={() => setReorderKey(null)}>Order again</Button>
              ) : null}
              {canCancel ? (
                <button
                  type="button"
                  onClick={() => setConfirmCancel(true)}
                  className="text-xs font-medium text-ink-500 underline underline-offset-2 transition-colors hover:text-danger"
                >
                  Cancel order
                </button>
              ) : null}
              <OrderStatusBadge status={order.status} />
            </div>
          </div>

          <Modal
            open={confirmCancel}
            onOpenChange={setConfirmCancel}
            title={`Cancel order ${order.orderNumber}?`}
            description={
              isPaid
                ? "We'll refund the full amount to your original payment method, usually within 5–7 working days."
                : "Nothing has been charged, so there's nothing to refund."
            }
            className="max-w-md"
          >
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="ghost"
                onClick={() => setConfirmCancel(false)}
                disabled={isCancelling}
              >
                Keep order
              </Button>
              <Button
                variant="sale"
                onClick={() => void onCancel()}
                disabled={isCancelling}
              >
                {isCancelling ? "Cancelling…" : "Cancel order"}
              </Button>
            </div>
          </Modal>

          {/* --------------------------------------------- payment still due */}
          {awaitingPayment ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-copper-200 bg-copper-50 p-5">
              <div className="flex items-start gap-3">
                <AlertCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-copper-700"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <div className="text-xs leading-relaxed text-ink-700">
                  <p className="text-sm font-medium text-ink">
                    Payment is still due
                  </p>
                  <p className="mt-1">
                    Nothing has been charged and the items are held for you. It
                    is the same payment as before &mdash; you will not be
                    charged twice.
                  </p>
                </div>
              </div>

              <ButtonLink href={payHref}>
                Pay {formatPrice(order.totals.amountDue ?? order.totals.total)}
              </ButtonLink>
            </div>
          ) : null}

          {/* ----------------------------------------------------- tracker */}
          {order.status === "cancelled" || order.status === "returned" ? (
            // A delivery tracker with every step blank, and an "expected"
            // date, only suggested the order was still coming.
            <section className="rounded-card border border-ink-200 bg-shell p-5">
              <p className="text-sm font-medium text-ink">
                {order.status === "cancelled"
                  ? "This order was cancelled."
                  : "This order was returned to us."}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-ink-500">
                {order.paymentStatus === "refunded"
                  ? "Your refund has been issued to your original payment method."
                  : isPaid
                    ? "Your refund is on its way — online payments usually reach you in 5–7 working days."
                    : "Nothing was charged for it."}
              </p>
            </section>
          ) : (
            <section
              aria-label="Delivery progress"
              className="rounded-card border border-ink-200 bg-shell p-5"
            >
              <ol className="flex flex-col gap-0 lg:flex-row lg:items-start">
                {ORDER_TIMELINE.map((stage, index) => {
                  const currentIndex = ORDER_TIMELINE.indexOf(order.status);
                  const reached = currentIndex >= index && currentIndex !== -1;
                  const isLast = index === ORDER_TIMELINE.length - 1;

                  return (
                    <li
                      key={stage}
                      className="flex flex-1 gap-3 lg:flex-col lg:gap-2"
                      aria-current={currentIndex === index ? "step" : undefined}
                    >
                      <div className="flex flex-col items-center lg:w-full lg:flex-row">
                        <span
                          className={cn(
                            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill text-[0.625rem] tabular-nums",
                            reached
                              ? "bg-sage-500 text-white"
                              : "bg-ink-100 text-ink-400",
                          )}
                        >
                          {reached ? (
                            <Check
                              className="h-3.5 w-3.5"
                              strokeWidth={2.5}
                              aria-hidden="true"
                            />
                          ) : (
                            index + 1
                          )}
                        </span>

                        {!isLast ? (
                          <span
                            aria-hidden="true"
                            className={cn(
                              "my-1 w-px flex-1 lg:my-0 lg:mx-2 lg:h-px lg:w-auto lg:flex-1",
                              currentIndex > index
                                ? "bg-sage-500"
                                : "bg-ink-200",
                            )}
                          />
                        ) : null}
                      </div>

                      <div className="pb-5 lg:pb-0">
                        <p
                          className={cn(
                            "text-xs font-medium",
                            reached ? "text-ink" : "text-ink-400",
                          )}
                        >
                          {statusLabel(stage)}
                        </p>
                        {isLast ? (
                          <p className="mt-0.5 text-[0.6875rem] text-ink-400">
                            Expected {order.expectedDelivery}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {/* ------------------------------------- returns & replacements */}
          <OrderReturns order={order} />

          {/* ------------------------------------------------------- items */}
          <section className="rounded-card border border-ink-200 bg-shell p-5">
            <h2 className="label-wide text-ink">
              {order.lines.length} {order.lines.length === 1 ? "item" : "items"}
            </h2>

            <ul className="mt-4 flex flex-col divide-y divide-ink-100">
              {order.lines.map((line, index) => (
                <li
                  key={`${line.productId}-${line.size ?? ""}-${index}`}
                  className="flex items-center gap-3.5 py-3.5 first:pt-0"
                >
                  <Link
                    href={`/product/${line.productId}`}
                    className="shrink-0"
                    tabIndex={-1}
                  >
                    <ProductImage
                      src={line.image}
                      alt=""
                      sizes="64px"
                      wrapperClassName="h-20 w-16 rounded-card"
                    />
                  </Link>

                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink">
                      <Link
                        href={`/product/${line.productId}`}
                        className="transition-colors hover:text-copper-700"
                      >
                        {line.name}
                      </Link>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">{line.brand}</p>
                    {line.bundleName ? (
                      <p className="mt-0.5 text-xs text-copper-700">Part of bundle: {line.bundleName}</p>
                    ) : line.flashSaleId ? (
                      <p className="mt-0.5 text-xs text-clay-600">Flash sale price</p>
                    ) : null}
                    <p className="mt-1 text-xs text-ink-400">
                      {[line.size ? `Size ${line.size}` : null, line.color]
                        .filter(Boolean)
                        .join(" · ")}
                      {line.size || line.color ? " · " : ""}
                      Qty {line.quantity}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-sm text-ink tabular-nums">{formatPrice(line.lineTotal)}</p>
                    {line.id && !line.bundleName && order.status !== "pending" ? (
                      <button type="button" onClick={() => setReorderKey(`item:${line.id}`)}
                        className="mt-1 text-xs text-copper-700 underline-offset-2 hover:underline">Add to bag again</button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
          {reorderKey !== undefined ? (
            <ReorderDialog orderId={order.id} open only={reorderKey ?? undefined} onClose={() => setReorderKey(undefined)} />
          ) : null}

          {/* ------------------------------------------- address and totals */}
          <div className="grid gap-4 sm:grid-cols-2">
            <section className="rounded-card border border-ink-200 bg-shell p-5">
              <h2 className="label-wide text-ink">
                {order.status === "delivered"
                  ? "Delivered to"
                  : order.status === "cancelled"
                    ? "Delivery address"
                    : "Delivering to"}
              </h2>
              <div className="mt-3 text-sm leading-relaxed text-ink-700">
                <p className="font-medium text-ink">{order.address.fullName}</p>
                <p className="mt-0.5">
                  {order.address.line1}
                  {order.address.line2 ? `, ${order.address.line2}` : ""}
                </p>
                <p className="mt-0.5">
                  {order.address.city}, {order.address.state}{" "}
                  {order.address.pincode}
                </p>
                <p className="mt-0.5">+91 {order.address.phone}</p>
              </div>

              <h3 className="label-wide mt-5 text-ink">Delivery method</h3>
              <p className="mt-2 text-sm text-ink-700">
                {order.deliveryMethod.name} &middot;{" "}
                {order.deliveryMethod.estimate}
              </p>
            </section>

            <section className="rounded-card border border-ink-200 bg-shell p-5">
              <h2 className="label-wide text-ink">Payment</h2>

              <dl className="mt-3 flex flex-col gap-2.5 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-500">Subtotal</dt>
                  <dd className="text-ink tabular-nums">
                    {formatPrice(order.totals.subtotal)}
                  </dd>
                </div>

                {order.totals.couponDiscount > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-500">
                      Coupon
                      {order.totals.appliedCoupon
                        ? ` (${order.totals.appliedCoupon.code})`
                        : ""}
                    </dt>
                    <dd className="text-sage-600 tabular-nums">
                      − {formatPrice(order.totals.couponDiscount)}
                    </dd>
                  </div>
                ) : null}

                {(order.totals.memberDiscount ?? 0) > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-ink-500">Member savings</dt>
                    <dd className="text-sage-600 tabular-nums">
                      − {formatPrice(order.totals.memberDiscount ?? 0)}
                    </dd>
                  </div>
                ) : null}

                <div className="flex justify-between gap-4">
                  <dt className="text-ink-500">Delivery</dt>
                  <dd className="text-ink tabular-nums">
                    {order.totals.deliveryFee === 0
                      ? "Free"
                      : formatPrice(order.totals.deliveryFee)}
                  </dd>
                </div>
              </dl>

              <div className="mt-4 flex items-baseline justify-between border-t border-ink-200 pt-4">
                <span className="text-sm font-medium text-ink">
                  {isPaid
                    ? "Total paid"
                    : payOnDelivery
                      ? "To pay on delivery"
                      : "Total"}
                </span>
                <span className="font-display text-lg text-ink tabular-nums">
                  {formatPrice(order.totals.total)}
                </span>
              </div>

              {(order.totals.giftCardAmount ?? 0) + (order.totals.storeCreditAmount ?? 0) + (order.totals.pointsAmount ?? 0) > 0 ? (
                <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                  {(order.totals.giftCardAmount ?? 0) > 0 ? (
                    <div className="flex justify-between gap-4">
                      <dt className="text-ink-500">Gift card</dt>
                      <dd className="tabular-nums text-ink">− {formatPrice(order.totals.giftCardAmount ?? 0)}</dd>
                    </div>
                  ) : null}
                  {(order.totals.storeCreditAmount ?? 0) > 0 ? (
                    <div className="flex justify-between gap-4">
                      <dt className="text-ink-500">Store credit</dt>
                      <dd className="tabular-nums text-ink">− {formatPrice(order.totals.storeCreditAmount ?? 0)}</dd>
                    </div>
                  ) : null}
                  {(order.totals.pointsAmount ?? 0) > 0 ? (
                    <div className="flex justify-between gap-4">
                      <dt className="text-ink-500">Reward points ({(order.totals.pointsRedeemed ?? 0).toLocaleString("en-IN")})</dt>
                      <dd className="tabular-nums text-ink">− {formatPrice(order.totals.pointsAmount ?? 0)}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-4 font-medium">
                    <dt className="text-ink">Paid by {order.paymentMethod.name}</dt>
                    <dd className="tabular-nums text-ink">{formatPrice(order.totals.amountDue ?? 0)}</dd>
                  </div>
                </dl>
              ) : null}

              <p className="mt-3 text-xs text-ink-400">
                {awaitingPayment
                  ? `Awaiting payment by ${order.paymentMethod.name}.`
                  : isPaid
                    ? `Paid by ${order.paymentMethod.name}.`
                    : payOnDelivery
                      ? "Please have the exact amount ready for the courier."
                      : order.paymentStatus === "refunded"
                        ? "Refunded to your original payment method."
                        : "No payment was taken."}
              </p>

              {/*
                The invoice raised for this order.
                Shown only when there is one: orders placed before billing
                existed have none, and a link to nothing is worse than no link.
              */}
              {order.invoiceId ? (
                <Link
                  href={`/account/invoice?id=${order.invoiceId}`}
                  className="mt-4 inline-flex items-center gap-2 border-b border-copper-500 pb-0.5 text-xs text-copper-700 transition-colors hover:border-ink hover:text-ink"
                >
                  <FileText
                    className="h-3.5 w-3.5"
                    strokeWidth={1.75}
                    aria-hidden="true"
                  />
                  View invoice
                  {order.invoiceNumber ? ` ${order.invoiceNumber}` : ""}
                </Link>
              ) : null}
            </section>

            {/* Opens the support centre at "Orders" with this order already chosen. */}
            <section className="rounded-card border border-ink-200 bg-shell p-5">
              <h2 className="label-wide text-ink">Need help with this order?</h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-500">
                Something missing, wrong or late? Tell us and it goes straight to the right team.
              </p>
              <Link
                href={`/contact?topic=orders&order=${encodeURIComponent(order.id)}`}
                className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-copper-700 underline underline-offset-2 hover:text-ink"
              >
                <LifeBuoy className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
                Get help
              </Link>
            </section>
          </div>
        </div>
      )}
    </AccountShell>
  );
}
