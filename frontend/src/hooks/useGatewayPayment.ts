"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { GatewayHandoff } from "@/types";

import type { Choice } from "@/components/checkout/PaymentMethods";

import {
  closeQr,
  createQr,
  pollQr,
  verifyPayment,
} from "@/services/payments/paymentGatewayService";
import {
  startCustomPayment,
  type PaymentSelection,
} from "@/services/payments/razorpayCustom";
import { toast } from "@/store/toastStore";

/**
 * Driving a payment from our own interface.
 *
 * Every method — UPI, cards, net banking, wallets — goes through Razorpay's
 * Custom Checkout, which renders nothing: no modal, no iframe, no Razorpay
 * page. What the shopper sees is this store until their own UPI app or their
 * own bank's page (net banking sign-in, a card's 3-D Secure OTP) asks them to
 * authorise, which no merchant can replace. Cards are typed into our own form
 * (see `lib/payments/card.ts` and docs/payments-in-our-ui.md).
 *
 * The outcome is settled the same way for all of them: the three references
 * go to our server, which checks the signature with the key secret, reads the
 * payment back from the gateway and compares the amount with what was owed.
 * Nothing here decides whether money arrived.
 *
 * Orders verify through `/payments/{id}/verify`; a membership or a gift card
 * passes its own `verify`. Only an order payment can use the server's QR codes
 * (`serverQr`); the others get Custom Checkout's own UPI QR.
 */

export type Stage = "choosing" | "waiting" | "qr" | "confirming" | "expired";
export type Outcome = "paid" | "abandoned" | "failed";

export type GatewayConfirmation = { razorpayPaymentId: string; razorpayOrderId: string; razorpaySignature: string };

export interface GatewayPaymentOptions {
  /** Settle with our server. Defaults to the order payment's `/payments/{id}/verify`. */
  verify?: (paymentId: string, response: GatewayConfirmation) => Promise<unknown>;
  /** Use the server's single-use QR codes (order payments only). Default true. */
  serverQr?: boolean;
  /** Said when the payment is confirmed. */
  successMessage?: string;
}

export function useGatewayPayment(options: GatewayPaymentOptions = {}) {
  const { verify = verifyPayment, serverQr = true, successMessage = "Payment received" } = options;
  const [stage, setStage] = useState<Stage>("choosing");
  const [qr, setQr] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  /** Set when the UPI app must be opened by a fresh tap — see `startCustomPayment`. */
  const [tapToOpen, setTapToOpen] = useState<{ appName: string; open: () => void } | null>(null);

  /**
   * When the window closes, on this browser's clock.
   *
   * Built from the server's `secondsLeft` rather than its `expiresAt`, so a
   * shopper whose clock is wrong still sees the right amount of time. Set when
   * a payment starts; the page counts down to it.
   */
  const [deadline, setDeadline] = useState<number | null>(null);

  const startClock = useCallback((handoff: GatewayHandoff) => {
    if (typeof handoff.secondsLeft === "number") {
      setDeadline(Date.now() + handoff.secondsLeft * 1000);
    }
  }, []);
  /**
   * Set by `startCustomPayment`, so leaving the page stops the listeners and
   * retires a QR code nobody scanned.
   */
  const abandon = useRef<(() => void) | null>(null);

  useEffect(() => () => abandon.current?.(), []);

  const reset = useCallback(() => {
    setTapToOpen(null);
    setStage("choosing");
    setQr(null);
    setMessage("");
  }, []);

  /**
   * Confirm with our server, and report honestly when we cannot.
   *
   * A failure here is **not** a failed payment: the money may well have been
   * taken and only the confirmation lost. The wording says so, and the webhook
   * settles the order regardless of what this browser manages to report — so
   * the worst case is a confirmation page that catches up a moment later, not
   * a payment nobody recorded.
   */
  const confirm = useCallback(
    async (paymentId: string, response: GatewayConfirmation): Promise<Outcome> => {
      setStage("confirming");
      setQr(null);
      setMessage("Checking the payment with your bank…");

      try {
        await verify(paymentId, response);
        toast.success(successMessage);
        return "paid";
      } catch (error) {
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : "We could not confirm the payment. If money has left your account, your " +
              "order will update shortly — please do not pay again.",
        );
        return "failed";
      } finally {
        reset();
      }
    },
    [reset, verify, successMessage],
  );

  /** Every method: our interface throughout. */
  const payCustom = useCallback(
    async (handoff: GatewayHandoff, selection: PaymentSelection): Promise<Outcome> => {
      startClock(handoff);
      setStage("waiting");
      setMessage("Starting the payment…");

      return new Promise<Outcome>((resolve) => {
        let settled = false;
        const finish = (outcome: Outcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };

        startCustomPayment(handoff, selection, (event) => {
          if (event.type === "qr") {
            setQr(event.qr);
            return;
          }

          if (event.type === "waiting") {
            setMessage(event.message);
            return;
          }

          if (event.type === "error") {
            setTapToOpen(null);
            reset();
            toast.error(event.reason);
            finish("failed");
            return;
          }

          if (event.type === "tap-to-open") {
            setMessage(`Tap below to open ${event.appName} and approve the payment.`);
            setTapToOpen({
              appName: event.appName,
              open: () => {
                setTapToOpen(null);
                setMessage(`Complete the payment in ${event.appName}.`);
                event.open();
              },
            });
            return;
          }

          setTapToOpen(null);
          abandon.current = null;
          void confirm(handoff.paymentId, event.response).then(finish);
        })
          .then((stop) => {
            // Stopping has to answer the page too, or `pay` would never return.
            abandon.current = () => {
              stop();
              abandon.current = null;
              finish("abandoned");
            };
          })
          .catch((error: unknown) => {
            reset();
            toast.error(
              error instanceof Error && error.message
                ? error.message
                : "The payment could not be started.",
            );
            finish("failed");
          });
      });
    },
    [confirm, reset, startClock],
  );

  /**
   * Scan to pay.
   *
   * Mint a single-use code, show it, and ask the server every few seconds
   * whether the gateway has seen a scan. The webhook settles it too, so
   * closing the tab mid-scan still produces a paid order — the polling is
   * what makes the page move while somebody is watching it.
   */
  const payByQr = useCallback(
    async (handoff: GatewayHandoff): Promise<Outcome> => {
      startClock(handoff);
      setStage("qr");
      setMessage("Generating a code…");

      let code;
      try {
        code = await createQr(handoff.paymentId);
      } catch (error) {
        reset();
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : "A QR code could not be generated. Please use another method.",
        );
        return "failed";
      }

      setQr(code.imageUrl);
      setMessage("Scan with any UPI app. This page updates by itself.");

      return new Promise<Outcome>((resolve) => {
        let stopped = false;

        const stop = (outcome: Outcome) => {
          if (stopped) return;
          stopped = true;
          window.clearInterval(timer);
          abandon.current = null;
          resolve(outcome);
        };

        const timer = window.setInterval(() => {
          void pollQr(handoff.paymentId, code.id)
            .then((status) => {
              if (!status.paid || stopped) return;
              setStage("confirming");
              setQr(null);
              setMessage("Payment received. Finishing up…");
              toast.success("Payment received");
              stop("paid");
            })
            .catch(() => {
              /* a dropped poll is not a failed payment; the next one tries */
            });
        }, 3000);

        /**
         * Leaving the page closes the code.
         *
         * A single-use code that nobody scanned should not survive the visit,
         * or it could be scanned tomorrow against an order long since dealt
         * with.
         */
        abandon.current = () => {
          void closeQr(handoff.paymentId, code.id).catch(() => {});
          stop("abandoned");
        };
      });
    },
    [reset, startClock],
  );

  /** Route a choice to the right flow. */
  const pay = useCallback(
    (handoff: GatewayHandoff, choice: Choice): Promise<Outcome> => {
      switch (choice.kind) {
        case "card":
          return payCustom(handoff, { method: "card", card: choice.card });
        case "upi-qr":
          // Razorpay's QR Codes product, not Checkout's qr flow — see
          // `createQr`. It works on accounts whose Checkout UPI is off, but it
          // is minted per order payment; anything else uses Checkout's QR.
          return serverQr ? payByQr(handoff) : payCustom(handoff, { method: "upi", flow: "qr" });
        case "upi-intent":
          return payCustom(handoff, {
            method: "upi",
            flow: "intent",
            app: choice.app,
            tappedAt: choice.tappedAt,
          });
        case "upi-vpa":
          return payCustom(handoff, { method: "upi", flow: "collect", vpa: choice.vpa });
        case "netbanking":
          return payCustom(handoff, { method: "netbanking", bank: choice.bank });
        case "wallet":
          return payCustom(handoff, { method: "wallet", wallet: choice.wallet });
        case "cod":
          // Never reaches a gateway; the page returns before calling this.
          return Promise.resolve("paid");
      }
    },
    [payByQr, payCustom, serverQr],
  );

  /**
   * The window closed while they were paying. Stop, and say so.
   *
   * Leaving the page's listeners running would keep polling a QR code the
   * server has already retired; `abandon` closes it and stops the poll.
   */
  const expire = useCallback(() => {
    abandon.current?.();
    setQr(null);
    setStage("expired");
    setMessage("The time to pay ran out, so the items have been released.");
  }, []);

  /**
   * Stop whatever payment is under way, and go back to choosing.
   *
   * For the page's "Pay another way" and "Cancel order". Closes a QR code that
   * was never scanned and stops listening for an approval; the `pay` call that
   * started it answers "abandoned".
   *
   * Stopping listening does not stop a payment the customer already approved.
   * That still reaches the server by webhook and is settled — or, on an order
   * that has been cancelled meanwhile, refunded.
   */
  const cancel = useCallback(() => {
    abandon.current?.();
    abandon.current = null;
    reset();
  }, [reset]);

  return {
    pay,
    cancel,
    tapToOpen,
    stage,
    qr,
    message,
    deadline,
    startClock,
    expire,
    isPaying: stage !== "choosing" && stage !== "expired",
  };
}
