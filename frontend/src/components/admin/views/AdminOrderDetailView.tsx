"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Check, Loader2, Package, Truck } from "lucide-react";

import type { AdminOrderStatus } from "@/types/admin";

import {
  AdminButton,
  AdminButtonLink,
  AdminCard,
  AdminPageHeader,
} from "@/components/admin/ui/AdminChrome";
import { AdminSelect, AdminTextarea } from "@/components/admin/ui/AdminForm";
import { DomainStatus, humanStatus } from "@/components/admin/ui/StatusBadge";
import { OrderBillingPanel } from "@/components/admin/views/OrderBillingPanel";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { currentActorId } from "@/services/admin/adminAuthService";
import {
  allowedTransitions,
  getOrder,
  updateOrderStatus,
} from "@/services/admin/orderAdminService";
import { toast } from "@/store/toastStore";

/** The happy path, for the progress tracker. */
const FUNNEL: AdminOrderStatus[] = ["pending", "confirmed", "processing", "shipped", "delivered"];

/**
 * One order in full, with the ability to advance its status.
 *
 * The status control only offers transitions the service considers legal, so a
 * delivered order cannot be pushed back into processing and a cancelled one
 * cannot be revived. The timeline below is append-only — it records what
 * happened rather than the current state.
 */
export function AdminOrderDetailView() {
  const searchParams = useSearchParams();
  const orderId = searchParams?.get("id") ?? "";

  const { data: order, isLoading, reload } = useAdminResource(
    () => (orderId ? getOrder(orderId) : Promise.resolve(null)),
    [orderId],
  );

  const [nextStatus, setNextStatus] = useState<AdminOrderStatus | "">("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-admin-faint" aria-label="Loading order" />
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
            No order matches <code>{orderId || "(none)"}</code>.
          </p>
          <AdminButtonLink href="/admin/orders" variant="secondary" className="mt-5">
            Back to orders
          </AdminButtonLink>
        </div>
      </div>
    );
  }

  const transitions = allowedTransitions(order.status);
  const currentIndex = FUNNEL.indexOf(order.status);
  const isTerminal = transitions.length === 0;

  const onUpdateStatus = async () => {
    if (!nextStatus) return;
    setSaving(true);
    const result = await updateOrderStatus(order.id, nextStatus, note.trim(), currentActorId());
    setSaving(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`Order ${order.orderNumber} is now ${humanStatus(nextStatus).toLowerCase()}`);
    setNextStatus("");
    setNote("");
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
            <DomainStatus domain="order" status={order.status} />
          </span>
        }
      />

      {/* ------------------------------------------------- progress tracker */}
      <AdminCard title="Progress" className="mb-4">
        <ol className="flex flex-col gap-0 sm:flex-row sm:items-start">
          {FUNNEL.map((stage, index) => {
            // Cancelled and returned orders left the funnel; nothing after the
            // point they left should read as reached.
            const reached = currentIndex >= index && currentIndex !== -1;
            const isLast = index === FUNNEL.length - 1;

            return (
              <li
                key={stage}
                className="flex flex-1 gap-3 sm:flex-col sm:gap-2"
                aria-current={currentIndex === index ? "step" : undefined}
              >
                <div className="flex flex-col items-center sm:w-full sm:flex-row">
                  <span
                    className={cn(
                      "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill text-[0.625rem] tabular-nums",
                      reached ? "bg-[#0ca30c] text-white" : "bg-admin-border text-admin-muted",
                    )}
                  >
                    {reached ? (
                      <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
                    ) : (
                      index + 1
                    )}
                  </span>

                  {!isLast ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "my-1 w-px flex-1 sm:my-0 sm:mx-2 sm:h-px sm:w-auto sm:flex-1",
                        currentIndex > index ? "bg-[#0ca30c]" : "bg-admin-border",
                      )}
                    />
                  ) : null}
                </div>

                <p
                  className={cn(
                    "pb-4 text-xs sm:pb-0",
                    reached ? "font-medium text-admin-ink" : "text-admin-muted",
                  )}
                >
                  {humanStatus(stage)}
                </p>
              </li>
            );
          })}
        </ol>

        {currentIndex === -1 ? (
          <p className="mt-3 rounded-[3px] bg-[#fdeee7] px-3 py-2 text-xs text-[#9c4a24]">
            This order was {order.status} and has left the normal flow.
          </p>
        ) : null}
      </AdminCard>

      <div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          {/* --------------------------------------------------------- items */}
          <AdminCard title={`${order.lines.length} ${order.lines.length === 1 ? "item" : "items"}`}>
            <ul className="flex flex-col divide-y divide-admin-border">
              {order.lines.map((line, index) => (
                <li
                  key={`${line.productId}-${line.size ?? ""}-${index}`}
                  className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <span className="h-14 w-11 shrink-0 overflow-hidden rounded-[2px] bg-admin-raised">
                    {line.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={line.image} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </span>

                  <span className="min-w-0 flex-1">
                    <Link
                      href={`/admin/products/edit?id=${line.productId}`}
                      className="block truncate text-xs font-medium text-admin-ink hover:text-copper-700"
                    >
                      {line.name}
                    </Link>
                    <span className="block text-[0.625rem] text-admin-faint">{line.sku}</span>
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
              <Row label="Subtotal" value={formatPrice(order.totals.subtotal)} />
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
              <Row
                label="Delivery"
                value={order.totals.deliveryFee === 0 ? "Free" : formatPrice(order.totals.deliveryFee)}
              />
              <Row
                label={`Tax included (${order.totals.taxAmount > 0 ? "5%" : "0%"})`}
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
          <OrderBillingPanel orderId={order.id} />

          {/* ------------------------------------------------------ timeline */}
          <AdminCard title="Timeline" description="Append-only history of this order.">
            <ol className="flex flex-col gap-3">
              {[...order.timeline].reverse().map((event, index) => (
                <li key={`${event.status}-${event.at}-${index}`} className="flex gap-2.5">
                  <span
                    aria-hidden="true"
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill bg-copper-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-admin-ink">
                      {humanStatus(event.status)}
                    </span>
                    <span className="block text-[0.625rem] text-admin-muted">
                      {formatDate(event.at)} · by {event.by}
                    </span>
                    {event.note ? (
                      <span className="mt-0.5 block text-[0.6875rem] italic text-admin-muted">
                        {event.note}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          </AdminCard>
        </div>

        {/* -------------------------------------------------- side column */}
        <div className="flex flex-col gap-4">
          <AdminCard title="Update status">
            {isTerminal ? (
              <p className="text-xs leading-relaxed text-admin-muted">
                This order is {order.status} and cannot be moved any further. That is deliberate —
                a terminal status is a record, not a stage.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <AdminSelect
                  label="Move to"
                  value={nextStatus}
                  onChange={(event) => setNextStatus(event.target.value as AdminOrderStatus)}
                  placeholder="Choose a status"
                  options={transitions.map((option) => ({
                    value: option,
                    label: humanStatus(option),
                  }))}
                />

                <AdminTextarea
                  label="Note"
                  rows={2}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  hint="Optional. Appears on the timeline."
                />

                <AdminButton
                  variant="primary"
                  onClick={() => void onUpdateStatus()}
                  disabled={!nextStatus}
                  loading={saving}
                >
                  Update status
                </AdminButton>
              </div>
            )}
          </AdminCard>

          <AdminCard title="Customer">
            <p className="text-xs font-medium text-admin-ink">{order.customerName}</p>
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
              {order.shippingAddress.line2 ? `, ${order.shippingAddress.line2}` : ""}
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
                <dd className="text-admin-ink">{order.paymentMethod}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-admin-muted">Payment</dt>
                <dd>
                  <DomainStatus domain="payment" status={order.paymentStatus} />
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="flex items-center gap-1.5 text-admin-muted">
                  <Truck className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                  Tracking
                </dt>
                <dd className="text-right text-admin-ink">
                  {order.trackingNumber ? (
                    <span className="font-mono text-[0.625rem]">{order.trackingNumber}</span>
                  ) : (
                    <span className="flex items-center gap-1 text-admin-faint">
                      <Package className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                      Not shipped
                    </span>
                  )}
                </dd>
              </div>
            </dl>
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
          positive ? "text-[#0a6b0a]" : muted ? "text-admin-faint" : "text-admin-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
