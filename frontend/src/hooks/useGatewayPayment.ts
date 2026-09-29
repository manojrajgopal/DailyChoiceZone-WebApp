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
import { openRazorpayCheckout } from "@/services/payments/razorpayCheckout";
import {
  startCustomPayment,
  type PaymentSelection,
} from "@/services/payments/razorpayCustom";
import { toast } from "@/store/toastStore";

/**
 * Driving a payment from our own interface.
 *
 * Two routes into the gateway, chosen by what the shopper picked:
 *
 * - **UPI, net banking, wallets** go through Custom Checkout, which renders
 *   nothing. The page stays ours; the shopper authorises in their own app or
 *   their own bank's page, which is unavoidable and is also the only place it
 *   should happen.
 * - **Cards** go through Standard Checkout's secure field. A card number
 *   entered into our own markup would put PANs in this application's
 *   JavaScript — a PCI-DSS decision, not a design one — so the card panel says
 *   so and this is the one flow that shows the processor's own field.
 *
 * Either way the outcome is settled the same way: the three references go to
 * our server, which checks the signature with the key secret, reads the
 * payment back from the gateway and compares the amount with the invoice.
 * Nothing here decides whether money arrived.
 */

export type Stage = "choosing" | "waiting" | "qr" | "card" | "confirming" | "expired";
export type Outcome = "paid" | "abandoned" | "failed";

export function useGatewayPayment() {
  const [stage, setStage] = useState<Stage>("choosing");
  const [qr, setQr] = useState<string | null>(null);
  const [message, setMessage] = useState("");

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
    async (
      paymentId: string,
      response: { razorpayPaymentId: string; razorpayOrderId: string; razorpaySignature: string },
    ): Promise<Outcome> => {
      setStage("confirming");
      setQr(null);
      setMessage("Checking the payment with your bank…");

      try {
        await verifyPayment(paymentId, response);
        toast.success("Payment received");
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
    [reset],
  );

  /**
   * Cards: the processor's secure field, embedded in the page.
   *
   * `container` is what keeps it out of a floating window — Razorpay draws
   * into that element as part of this step. The card fields themselves stay
   * the processor's, because a card number in our own markup would put PANs in
   * this application's JavaScript.
   */
  const payByCard = useCallback(
    async (handoff: GatewayHandoff, container?: string): Promise<Outcome> => {
      setStage("card");
      setMessage("Enter your card details below.");

      try {
        startClock(handoff);
        const outcome = await openRazorpayCheckout(handoff, {
          container,
          only: "card",
        });

        if (outcome.status === "dismissed") {
          reset();
          toast.info("Payment cancelled. Your order is saved — you can pay any time.");
          return "abandoned";
        }

        if (outcome.status === "failed") {
          reset();
          toast.error(outcome.reason);
          return "failed";
        }

        return confirm(handoff.paymentId, outcome.response);
      } catch (error) {
        reset();
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : "The payment gateway could not be opened.",
        );
        return "failed";
      }
    },
    [confirm, reset, startClock],
  );

  /** UPI, net banking and wallets: our interface throughout. */
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
            reset();
            toast.error(event.reason);
            finish("failed");
            return;
          }

          void confirm(handoff.paymentId, event.response).then(finish);
        })
          .then((stop) => {
            abandon.current = stop;
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
          return payByCard(handoff, choice.container);
        case "upi-qr":
          // Razorpay's QR Codes product, not Checkout's qr flow — see
          // `createQr`. It works on accounts whose Checkout UPI is off.
          return payByQr(handoff);
        case "upi-intent":
          return payCustom(handoff, { method: "upi", flow: "intent", app: choice.app });
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
    [payByCard, payByQr, payCustom],
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

  return {
    pay,
    stage,
    qr,
    message,
    deadline,
    startClock,
    expire,
    isPaying: stage !== "choosing" && stage !== "expired",
  };
}
