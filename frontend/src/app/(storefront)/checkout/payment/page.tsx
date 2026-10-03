"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Loader2, Lock, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/Button";
import {
  CheckoutShell,
  summaryLinesFromOrder,
  type CheckoutSummary,
} from "@/components/checkout/CheckoutShell";
import { PaymentCountdown } from "@/components/checkout/PaymentCountdown";
import { NO_TENDERS, TendersPanel, type TenderSelection } from "@/components/checkout/TendersPanel";
import {
  PaymentMethods,
  methodFor,
  type Choice,
} from "@/components/checkout/PaymentMethods";

import type { BillingBreakdown, GatewayHandoff, Order, OrderLine, PaymentMethod } from "@/types";
import type { TenderPreview } from "@/services/walletService";
import { useCart } from "@/hooks/useCart";
import { CartAvailabilityNotice, useCartAvailability } from "@/components/checkout/CartAvailabilityNotice";
import { PaymentProgress } from "@/components/checkout/PaymentProgress";
import { useGatewayPayment } from "@/hooks/useGatewayPayment";
import { useCheckoutHydrated } from "@/hooks/useStoreHydrated";
import { formatPrice } from "@/lib/utils/format";
import { getMyInvoice } from "@/services/billing/invoiceService";
import { addToCart } from "@/services/cartService";
import { getPaymentSession, openOnlinePayment } from "@/services/payments/paymentGatewayService";
import { preloadCustomCheckout } from "@/services/payments/razorpayCustom";
import { cancelOrder, getOrder, placeOrder } from "@/services/orderService";
import { ApiError } from "@/services/api/client";
import { getDeliveryMethod, getPaymentMethod } from "@/services/orderService";
import { useCheckoutStore } from "@/store/checkoutStore";
import { toast } from "@/store/toastStore";


export default function CheckoutPaymentPage() {
  return (
    <Suspense fallback={null}>
      <PaymentStep />
    </Suspense>
  );
}

function PaymentStep() {
  const router = useRouter();
  const searchParams = useSearchParams();

  /**
   * Paying for an order that already exists, rather than placing one.
   *
   * The confirmation page and the account order page send people here with
   * `?payment=…` when a payment was left unfinished. They used to open
   * Razorpay's own modal instead, which meant one checkout with two different
   * interfaces — the custom panels on the way through, and a floating window
   * with somebody else's branding on the way back. This is the same page
   * either way; only where the gateway order comes from differs.
   */
  const existingPaymentId = searchParams?.get("payment") ?? "";
  const settling = Boolean(existingPaymentId);
  // A cash-on-delivery order being paid online instead (the store's own link).
  const payingOnline = searchParams?.get("online") === "1";
  const checkoutHydrated = useCheckoutHydrated();
  const { lines, totals, breakdown, clear, delivery, couponCode, bundles, refresh } = useCart();
  const bagEmpty = lines.length === 0 && bundles.length === 0;

  /**
   * Gift cards, store credit and points the shopper put towards the order,
   * and what the server says they'd pay. Kept in memory only: a gift card
   * code is never written to storage.
   */
  const [tenders, setTenders] = useState<TenderSelection>(NO_TENDERS);
  const [tenderPreview, setTenderPreview] = useState<TenderPreview | null>(null);
  const covered = Boolean(tenderPreview && tenderPreview.tenderTotal > 0 && tenderPreview.amountDue === 0);

  const contact = useCheckoutStore((state) => state.contact);
  const address = useCheckoutStore((state) => state.address);
  // Checked again here, in case something changed since the address step;
  // the order itself is checked once more on the server.
  const bagAvailability = useCartAvailability(settling ? null : address?.pincode);
  const billingSame = useCheckoutStore((state) => state.billingSameAsShipping);
  const storedBilling = useCheckoutStore((state) => state.billingAddress);
  const deliveryMethodId = useCheckoutStore((state) => state.deliveryMethodId);
  const setPaymentMethod = useCheckoutStore((state) => state.setPaymentMethod);
  const resetCheckout = useCheckoutStore((state) => state.reset);

  const [isPlacing, setIsPlacing] = useState(false);

  /**
   * Latched once the order exists, and never cleared.
   *
   * Placing an order empties the bag on purpose, and the shell's empty-bag
   * guard would then redirect to /cart — racing the navigation to the
   * confirmation page and usually winning. `isPlacing` is not enough on its
   * own, because it goes false the moment the request returns and the guard
   * fires in the gap before the push lands.
   */
  const [placed, setPlaced] = useState(false);

  /**
   * The amount being collected, captured before the bag is emptied.
   *
   * `totals.total` comes from the cart, and placing the order empties it — so
   * by the time the QR code or the waiting panel is on screen the cart says
   * zero. The figure shown has to be the one the order was placed for.
   */
  const [amountDue, setAmountDue] = useState<number | null>(null);

  const { pay, cancel, tapToOpen, stage, qr, message, isPaying, deadline, startClock, expire } =
    useGatewayPayment();

  // Load the UPI script now, so a tap on a UPI app is not spent downloading it.
  useEffect(() => preloadCustomCheckout(), []);

  /** The gateway order for an existing payment, when settling one. */
  const [existing, setExisting] = useState<GatewayHandoff | null>(null);
  const [orderNumber, setOrderNumber] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  /**
   * The order being paid for, for the side panel — not the bag, which placing
   * the order emptied. Starts `null` (loading) when resuming a payment.
   */
  const [summary, setSummary] = useState<CheckoutSummary | null | undefined>(
    settling ? null : undefined,
  );
  const [orderLines, setOrderLines] = useState<OrderLine[]>([]);
  const [activePaymentId, setActivePaymentId] = useState(existingPaymentId);

  /**
   * Set when the customer stops a payment from this page's own buttons, so the
   * `pay` call that then returns "abandoned" does not also navigate away.
   */
  const exit = useRef<"switch" | "cancel" | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  /** The order and its invoice, as the side panel shows them. */
  const showOrder = (order: Order, fallback?: BillingBreakdown, invoiceId?: string | null) => {
    setOrderLines(order.lines);
    const base = {
      lines: summaryLinesFromOrder(order.lines),
      // No "add more for free delivery" nudge on an order already placed.
      totals: { ...order.totals, freeDeliveryShortfall: 0 },
    };
    if (fallback) setSummary({ ...base, breakdown: fallback });

    const id = invoiceId ?? order.invoiceId;
    if (!id) {
      if (!fallback) setSummary(undefined);
      return;
    }
    // The invoice is the authority on what is owed.
    void getMyInvoice(id)
      .then((invoice) => {
        if (invoice) setSummary({ ...base, breakdown: invoice.breakdown });
        else if (!fallback) setSummary(undefined);
      })
      .catch(() => {
        if (!fallback) setSummary(undefined);
      });
  };

  useEffect(() => {
    if (!settling) return;

    let active = true;
    void (payingOnline ? openOnlinePayment(existingPaymentId) : getPaymentSession(existingPaymentId))
      .then((session) => {
        if (!active) return;

        setOrderNumber(session.orderNumber);

        if (!session.gateway) {
          // Settled while they were away — very likely the webhook. Nothing
          // to pay, so show them the order rather than a payment screen.
          router.replace(
            session.orderNumber
              ? `/order-success?order=${encodeURIComponent(session.orderNumber)}`
              : "/account/orders",
          );
          return;
        }

        setExisting(session.gateway);
        startClock(session.gateway);
        // The handoff carries minor units; the display works in major.
        setAmountDue(session.gateway.amount / 100);

        void getOrder(session.orderNumber)
          .then((order) => {
            if (!active) return;
            if (order) showOrder(order);
            else setSummary(undefined);
          })
          .catch(() => {
            if (active) setSummary(undefined);
          });
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });

    return () => {
      active = false;
    };
  }, [settling, payingOnline, existingPaymentId, router, startClock]);


  const busy = isPlacing || isPaying;

  /**
   * Earlier steps are prerequisites; send deep links back to the first gap.
   *
   * Skipped once an order is in flight, because emptying the bag is part of
   * placing one and must not read as somebody arriving with nothing filled in.
   */
  useEffect(() => {
    // Settling an existing payment needs no cart and no checkout state — the
    // order it belongs to was placed long before this visit.
    if (settling || !checkoutHydrated || busy || placed) return;
    if (!contact.email) router.replace("/checkout");
    else if (!address) router.replace("/checkout/address");
  }, [settling, checkoutHydrated, busy, placed, contact.email, address, router]);

  const onPay = async (choice: Choice) => {
    /**
     * Settling an existing payment: the gateway order is already open, so
     * there is nothing to place and nothing to clear. Straight to the rails.
     */
    if (settling) {
      if (!existing) return;

      exit.current = null;
      const outcome = await pay(existing, choice);
      if (exit.current || !alive.current) return;

      if (!orderNumber) {
        router.push("/account/orders");
        return;
      }

      const confirmation = `/order-success?order=${encodeURIComponent(orderNumber)}`;
      router.push(
        outcome === "paid"
          ? confirmation
          : `${confirmation}&payment=${encodeURIComponent(existing.paymentId)}`,
      );
      return;
    }

    if (!address || bagEmpty) return;

    const method = methodFor(choice);
    setPaymentMethod(method);
    setIsPlacing(true);

    let placed;
    try {
      /**
       * The order, then the money — in one press, in that order.
       *
       * The server prices the cart it holds and creates the order, the
       * invoice and the payment in a single transaction. Nothing this page
       * says about money is read; `choice` contributes a *method*, not a
       * total.
       */
      placed = await placeOrder({
        lines,
        totals,
        address: { ...address, id: "" },
        billingAddress: billingSame ? null : storedBilling,
        deliveryMethod: getDeliveryMethod(deliveryMethodId),
        paymentMethod: getPaymentMethod(method),
        email: contact.email,
        expectedTotal: breakdown.grandTotal,
        ...tenders,
      });
    } catch (error) {
      setIsPlacing(false);
      // A price or offer changed since the bag was shown: show the new figures.
      if (error instanceof ApiError && error.code === "PRICE_CHANGED") refresh();
      // The API's message names what actually went wrong — an item that sold
      // out, a coupon that stopped applying.
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "We could not place your order. Please try again.",
      );
      return;
    }

    const confirmation =
      `/order-success?order=${encodeURIComponent(placed.order.orderNumber)}` +
      (placed.invoiceId ? `&invoice=${encodeURIComponent(placed.invoiceId)}` : "");

    /**
     * The bag is emptied before the payment is attempted, not after.
     *
     * The order already owns these items — the stock is committed and the
     * invoice is issued. Leaving them in the bag would let somebody abandon
     * the payment and buy the same things twice, and an unpaid order is
     * recoverable from the confirmation page either way.
     */
    setPlaced(true);
    // What the gateway will charge, which is the server's figure for the order.
    setAmountDue(placed.gateway ? placed.gateway.amount / 100 : placed.order.totals.total);
    setOrderNumber(placed.order.orderNumber);
    setActivePaymentId(placed.paymentId);
    showOrder(placed.order, breakdown, placed.invoiceId);
    clear();
    resetCheckout();
    setIsPlacing(false);

    // Nothing to pay: cash on delivery, or a provider that settled it.
    if (!placed.gateway) {
      router.push(confirmation);
      return;
    }

    exit.current = null;
    const outcome = await pay(placed.gateway, choice);
    if (exit.current || !alive.current) return;

    router.push(
      outcome === "paid"
        ? confirmation
        : `${confirmation}&payment=${encodeURIComponent(placed.paymentId)}`,
    );
  };

  /**
   * Gift cards, store credit and points cover the whole order: there's no
   * payment method to choose, so the order is placed and confirmed outright.
   */
  const onPlaceCovered = async () => {
    if (!address || bagEmpty) return;
    setIsPlacing(true);
    try {
      const result = await placeOrder({
        lines,
        totals,
        address: { ...address, id: "" },
        billingAddress: billingSame ? null : storedBilling,
        deliveryMethod: getDeliveryMethod(deliveryMethodId),
        paymentMethod: { ...getPaymentMethod("upi"), id: "tender" } as PaymentMethod,
        email: contact.email,
        expectedTotal: breakdown.grandTotal,
        ...tenders,
      });
      setPlaced(true);
      clear();
      resetCheckout();
      router.push(
        `/order-success?order=${encodeURIComponent(result.order.orderNumber)}` +
          (result.invoiceId ? `&invoice=${encodeURIComponent(result.invoiceId)}` : ""),
      );
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "We could not place your order. Please try again.");
    } finally {
      setIsPlacing(false);
    }
  };

  /**
   * Back to the list of methods, same order, same clock.
   *
   * A freshly placed order moves to its `?payment=` address — the page that
   * reopens an existing payment — because the bag it was placed from is empty
   * now and there is nothing left to place.
   */
  const onPayAnotherWay = () => {
    exit.current = "switch";
    cancel();
    setConfirmCancel(false);
    if (!settling && activePaymentId) {
      router.replace(`/checkout/payment?payment=${encodeURIComponent(activePaymentId)}`);
    }
  };

  /**
   * Cancel the order outright.
   *
   * The server releases the held stock, retires the QR code and any payment
   * link, and refunds anything that did get paid — so a customer who scanned
   * and then pressed cancel is not left out of pocket. The items go back into
   * the bag, since cancelling a payment is rarely deciding against the things.
   */
  const onCancelOrder = async () => {
    if (!orderNumber) return;
    exit.current = "cancel";
    setCancelling(true);
    cancel();

    try {
      await cancelOrder(orderNumber, "Cancelled by the customer at payment.");
    } catch (error) {
      setCancelling(false);
      setConfirmCancel(false);
      exit.current = null;
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : "We could not cancel the order. Please try again.",
      );
      if (!settling && activePaymentId) {
        router.replace(`/checkout/payment?payment=${encodeURIComponent(activePaymentId)}`);
      }
      return;
    }

    // Best effort, one line at a time: an item that has since sold out simply
    // does not come back, and that is not a reason to fail the cancellation.
    for (const line of orderLines) {
      try {
        await addToCart({
          productId: line.productId,
          size: line.size,
          color: line.color,
          quantity: Math.min(line.quantity, 10),
        });
      } catch {
        /* skipped */
      }
    }

    toast.success("Order cancelled. Your items are back in your bag.");
    router.push("/cart");
  };

  const exits = cancelling ? (
    <p className="mt-5 flex items-center justify-center gap-1.5 border-t border-ink-100 pt-4 text-xs text-ink-500">
      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
      Cancelling your order…
    </p>
  ) : orderNumber ? (
    <div className="mt-5 border-t border-ink-100 pt-4">
      {confirmCancel ? (
        <div className="text-left">
          <p className="text-sm font-medium text-ink">Cancel this order?</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-500">
            The items are released and go back into your bag. If a payment has already gone
            through, it is refunded to you automatically.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void onCancelOrder()}
              className="rounded-pill bg-ink px-4 py-2 text-xs font-medium text-cream transition-colors hover:bg-ink-800"
            >
              Yes, cancel order
            </button>
            <button
              type="button"
              onClick={() => setConfirmCancel(false)}
              className="rounded-pill border border-ink-200 px-4 py-2 text-xs font-medium text-ink transition-colors hover:border-ink-400"
            >
              Keep paying
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {stage !== "choosing" ? (
            <button
              type="button"
              onClick={onPayAnotherWay}
              className="text-xs font-medium text-ink-700 underline underline-offset-2 hover:text-copper-700"
            >
              Pay another way
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setConfirmCancel(true)}
            className="text-xs font-medium text-clay-700 underline underline-offset-2 hover:text-ink"
          >
            Cancel order
          </button>
        </div>
      )}
    </div>
  ) : null;

  return (
    <CheckoutShell
      title={settling ? "Finish paying" : "Payment"}
      description={
        settling
          ? `Nothing has been charged yet${orderNumber ? ` for order ${orderNumber}` : ""}. Choose how you would like to pay.`
          : "Choose how you would like to pay. Your order is placed and paid in one step."
      }
      // Settling an existing payment happens with an empty bag by definition,
      // so the empty-bag guard must never fire in that mode.
      suppressEmptyRedirect={settling || busy || placed || cancelling}
      detailedTax
      summary={summary}
    >

      {/*
        The window, counting down, whenever an order is holding stock for this
        payment. Hidden once it is paid or has already run out.
      */}
      {deadline !== null && stage !== "expired" && stage !== "confirming" ? (
        <div className="mb-5">
          <PaymentCountdown deadline={deadline} onExpire={expire} />
        </div>
      ) : null}

      {/* ----------------------------------------------- the window closed */}
      {stage === "expired" ? (
        <div className="max-w-2xl rounded-card border border-clay-200 bg-clay-50 p-5">
          <p className="text-sm font-medium text-ink">The time to pay has run out</p>
          <p className="mt-1.5 text-xs leading-relaxed text-ink-700">
            Nothing was charged. We held the items for you while you paid, and have now
            released them. If you completed a payment in the last moments, it will be
            refunded automatically.
          </p>
          <a
            href="/shop"
            className="mt-4 inline-block text-sm font-medium text-copper-700 underline underline-offset-2"
          >
            Continue shopping
          </a>
        </div>
      ) : null}

      {loadFailed ? (
        <p className="max-w-2xl rounded-card border border-clay-200 bg-clay-50 p-4 text-sm text-ink-700">
          We could not reopen that payment. Please check it from{" "}
          <a href="/account/orders" className="underline underline-offset-2">
            your orders
          </a>
          .
        </p>
      ) : null}
      {/* ------------------------------------------------------ scan, or wait */}
      <PaymentProgress
        stage={stage}
        qr={qr}
        message={message}
        tapToOpen={tapToOpen}
        amount={formatPrice(amountDue ?? totals.total)}
        exits={exits}
      />

      {/* -------------------------------------------------------- the choices */}
      {stage === "choosing" && settling && !existing && !loadFailed ? (
        <div className="max-w-2xl" aria-busy="true">
          <div className="h-16 animate-pulse rounded-card bg-ink-100" />
        </div>
      ) : null}

      {stage === "choosing" && (!settling || existing) ? (
        <div className="max-w-2xl">
          {!settling && !placed ? (
            <TendersPanel
              couponCode={couponCode}
              deliveryMethod={deliveryMethodId}
              placeOfSupply={(billingSame ? address?.state : storedBilling?.state) ?? null}
              pincode={address?.pincode ?? null}
              disabled={busy}
              onChange={(selection, preview) => {
                setTenders(selection);
                setTenderPreview(preview);
              }}
            />
          ) : null}

          {covered && !settling ? (
            <div className="rounded-card border border-sage-200 bg-sage-50 p-5">
              <p className="text-sm text-ink">
                <span className="font-medium">Nothing left to pay.</span> Your gift card, store credit and points
                cover this order.
              </p>
              <Button size="lg" fullWidth className="mt-4" disabled={busy} onClick={() => void onPlaceCovered()}>
                {busy ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
                    Placing order…
                  </>
                ) : (
                  "Place order"
                )}
              </Button>
            </div>
          ) : (
          <PaymentMethods
            onPay={onPay}
            isPaying={busy}
            total={formatPrice(amountDue ?? (tenderPreview ? tenderPreview.amountDue / 100 : totals.total))}
            codUnavailable={(delivery !== null && delivery.serviceable && !delivery.codAvailable)
              || bagAvailability.result?.codAvailable === false}
            // Finishing a payment that is already underway is paying online;
            // cash on delivery is chosen only when an order is first placed.
            allowCod={!settling}
            serverQr={!payingOnline}
          />
          )}
          <CartAvailabilityNotice result={bagAvailability.result} className="mt-4" />

          <div className="mt-6 flex items-start gap-3 rounded-card border border-sage-200 bg-sage-50 p-4">
            <ShieldCheck
              className="mt-0.5 h-4 w-4 shrink-0 text-sage-600"
              strokeWidth={1.75}
              aria-hidden="true"
            />
            <p className="text-xs leading-relaxed text-ink-700">
              <span className="font-medium text-ink">You are paying on this page.</span>{" "}
              Your bank or UPI app will ask you to approve the payment. We never see or store your card number, UPI PIN or bank password.
            </p>
          </div>

          <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-400">
            <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
            Secure payment
          </p>

          {/* Resuming an order: it exists, so it can be cancelled from here. */}
          {settling ? exits : null}
        </div>
      ) : null}

    </CheckoutShell>
  );
}
