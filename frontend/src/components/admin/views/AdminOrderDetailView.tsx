"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Check, Link2, Loader2, Package, Truck } from "lucide-react";

import type { AdminOrderStatus } from "@/types/admin";

import {
  AdminButton,
  AdminButtonLink,
  AdminCard,
  AdminPageHeader,
  ConfirmDialog,
} from "@/components/admin/ui/AdminChrome";
import { AdminTextarea } from "@/components/admin/ui/AdminForm";
import { DomainStatus, humanStatus } from "@/components/admin/ui/StatusBadge";
import { OrderBillingPanel } from "@/components/admin/views/OrderBillingPanel";
import { useAdminResource } from "@/hooks/useAdminResource";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { currentActorId } from "@/services/admin/adminAuthService";
import { ORDER_FLOW, ORDER_STAGES, flowIndex, needsConfirmation, stageLabel } from "@/lib/orders/orderFlow";
import {
  availableMovesFor,
  canSendPaymentLink,
  getOrder,
  sendPaymentLink,
  updateOrderStatus,
} from "@/services/admin/orderAdminService";
import { toast } from "@/store/toastStore";

/** The happy path, for the progress tracker. */
const FUNNEL: readonly AdminOrderStatus[] = ORDER_FLOW;

const MOVE_GROUPS = [
  { kind: "next", label: "Next step" },
  { kind: "skip", label: "Skip ahead — asks to confirm" },
  { kind: "back", label: "Move back — asks to confirm" },
  { kind: "cancel", label: "End the order" },
  { kind: "return", label: "End the order" },
] as const;

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
  const [confirming, setConfirming] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

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
            We couldn&rsquo;t find this order.
          </p>
          <AdminButtonLink href="/admin/orders" variant="secondary" className="mt-5">
            Back to orders
          </AdminButtonLink>
        </div>
      </div>
    );
  }

  const moves = availableMovesFor(order);
  const currentIndex = flowIndex(order.status);
  const isTerminal = moves.length === 0;
  const chosen = moves.find((move) => move.target === nextStatus);

  /**
   * The next stage goes straight through. Skipping a stage, going back, or
   * ending the order asks first — the server insists on `confirm` for the
   * first two as well, so a stray selection cannot rewrite an order's history.
   */
  const onRequestUpdate = () => {
    if (!chosen) return;
    if (chosen.kind === "next") void onUpdateStatus(false);
    else setConfirming(true);
  };

  const onUpdateStatus = async (confirm: boolean) => {
    if (!nextStatus) return;
    setSaving(true);
    const result = await updateOrderStatus(
      order.id,
      nextStatus,
      note.trim(),
      currentActorId(),
      confirm,
    );
    setSaving(false);
    setConfirming(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    toast.success(`Order ${order.orderNumber} is now ${stageLabel(nextStatus).toLowerCase()}`);
    setNextStatus("");
    setNote("");
    await reload();
  };

  const confirmCopy = chosen
    ? {
        skip: {
          title: "Skip ahead?",
          message: (
            <>
              This moves the order from <strong>{stageLabel(order.status)}</strong> straight to{" "}
              <strong>{stageLabel(chosen.target)}</strong>. {chosen.detail}. The timeline will
              record that these stages were skipped.
            </>
          ),
          label: `Skip to ${stageLabel(chosen.target)}`,
          destructive: false,
        },
        back: {
          title: "Move this order back?",
          message: (
            <>
              This moves the order back from <strong>{stageLabel(order.status)}</strong> to{" "}
              <strong>{stageLabel(chosen.target)}</strong>. The customer&rsquo;s tracking will
              show the earlier stage, and the timeline will record the change.
            </>
          ),
          label: `Move back to ${stageLabel(chosen.target)}`,
          destructive: true,
        },
        cancel: {
          title: "Cancel this order?",
          message: (
            <>
              The items go back into stock and anything paid is refunded. A cancelled order
              cannot be reopened.
            </>
          ),
          label: "Cancel order",
          destructive: true,
        },
        return: {
          title: "Record a return?",
          message: <>The order will be marked returned. This cannot be undone.</>,
          label: "Mark returned",
          destructive: true,
        },
        next: { title: "", message: null, label: "", destructive: false },
      }[chosen.kind]
    : null;

  const onSendPaymentLink = async () => {
    setSendingLink(true);
    const result = await sendPaymentLink(order.id);
    setSendingLink(false);

    if (!result.ok) {
      toast.error(result.reason);
      return;
    }

    setLinkUrl(result.data.shortUrl);
    toast.success(`Payment link sent to ${order.customerName}`);
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
            This order was {order.status}.
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
          <AdminCard title="Timeline" description="Every update to this order.">
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
                This order is {order.status}, so its status can no longer be changed.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <p className="text-[0.6875rem] leading-relaxed text-admin-muted">
                  Now <strong className="text-admin-ink">{stageLabel(order.status)}</strong>
                  {" — "}
                  {ORDER_STAGES[order.status]?.description}
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-admin-ink">Move to</span>
                  <select
                    value={nextStatus}
                    onChange={(event) => setNextStatus(event.target.value as AdminOrderStatus)}
                    className="h-9 w-full rounded-[3px] border border-admin-border bg-admin-surface px-2.5 text-xs text-admin-ink focus:border-copper-500 focus:outline-none"
                  >
                    <option value="">Choose a status</option>
                    {MOVE_GROUPS.filter(
                      (group, index, all) =>
                        all.findIndex((entry) => entry.label === group.label) === index,
                    ).map((group) => {
                      const inGroup = moves.filter(
                        (move) =>
                          MOVE_GROUPS.find((entry) => entry.kind === move.kind)?.label ===
                          group.label,
                      );
                      if (!inGroup.length) return null;
                      return (
                        <optgroup key={group.label} label={group.label}>
                          {inGroup.map((move) => (
                            <option key={move.target} value={move.target}>
                              {stageLabel(move.target)}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </label>

                {chosen && chosen.kind !== "next" ? (
                  <p className="rounded-[3px] bg-[#fdf3e3] px-2.5 py-2 text-[0.6875rem] leading-relaxed text-[#8a5a12]">
                    {chosen.kind === "skip"
                      ? `${chosen.detail}. You will be asked to confirm.`
                      : chosen.kind === "back"
                        ? `Moves the order backwards. You will be asked to confirm.`
                        : "Ends the order. You will be asked to confirm."}
                  </p>
                ) : null}

                <AdminTextarea
                  label="Note"
                  rows={2}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  hint="Optional. Appears on the timeline."
                />

                <AdminButton
                  variant="primary"
                  onClick={onRequestUpdate}
                  disabled={!nextStatus}
                  loading={saving && !confirming}
                >
                  Update status
                </AdminButton>

                {confirmCopy && needsConfirmation(chosen) !== undefined ? (
                  <ConfirmDialog
                    open={confirming}
                    onOpenChange={setConfirming}
                    title={confirmCopy.title}
                    message={confirmCopy.message}
                    confirmLabel={confirmCopy.label}
                    destructive={confirmCopy.destructive}
                    loading={saving}
                    onConfirm={() => void onUpdateStatus(needsConfirmation(chosen))}
                  />
                ) : null}
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

            {canSendPaymentLink(order) ? (
              <div className="mt-4 border-t border-admin-border pt-4">
                <p className="mb-3 text-[0.6875rem] leading-relaxed text-admin-muted">
                  Razorpay texts and emails the customer a link to pay now instead of in cash. It
                  stays open for 24 hours. The order is marked paid only when Razorpay confirms the
                  payment.
                </p>
                <AdminButton
                  variant="secondary"
                  onClick={() => void onSendPaymentLink()}
                  loading={sendingLink}
                >
                  <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Send payment link
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
          positive ? "text-[#0a6b0a]" : muted ? "text-admin-faint" : "text-admin-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
