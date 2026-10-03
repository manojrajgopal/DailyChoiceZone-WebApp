"use client";

import { useEffect } from "react";

import type { GatewayHandoff } from "@/types";

import { PaymentMethods } from "@/components/checkout/PaymentMethods";
import { PaymentProgress } from "@/components/checkout/PaymentProgress";
import { useGatewayPayment, type GatewayConfirmation } from "@/hooks/useGatewayPayment";
import { formatPrice } from "@/lib/utils/format";
import { preloadCustomCheckout } from "@/services/payments/razorpayCustom";

/**
 * Paying for something that isn't an order — a membership, a gift card — in
 * the same interface as checkout: UPI, cards, net banking and wallets as
 * panels of this page, no Razorpay window anywhere.
 *
 * `verify` settles the payment with the server (each has its own endpoint);
 * `onPaid` runs once it has; `onCancel` when the shopper backs out, so the
 * caller can release whatever it was holding.
 */
export function EmbeddedPayment({
  handoff,
  verify,
  onPaid,
  onCancel,
  successMessage,
  heading = "Choose how to pay",
}: {
  handoff: GatewayHandoff;
  verify: (response: GatewayConfirmation) => Promise<unknown>;
  onPaid: () => void;
  onCancel: () => void;
  successMessage?: string;
  heading?: string;
}) {
  const { pay, cancel, stage, qr, message, tapToOpen, isPaying } = useGatewayPayment({
    verify: (_paymentId, response) => verify(response),
    serverQr: false,
    successMessage,
  });
  const amount = formatPrice(handoff.amount / 100);

  useEffect(() => preloadCustomCheckout(), []);

  const exits = (
    <div className="mt-4 flex justify-center">
      <button
        type="button"
        onClick={cancel}
        className="text-xs font-medium text-ink-700 underline underline-offset-2 hover:text-copper-700"
      >
        Pay another way
      </button>
    </div>
  );

  return (
    <section aria-labelledby="embedded-payment-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="embedded-payment-heading" className="font-display text-xl text-ink">{heading}</h2>
        <p className="text-sm text-ink-500">
          To pay: <span className="font-medium text-ink tabular-nums">{amount}</span>
        </p>
      </div>

      <PaymentProgress stage={stage} qr={qr} message={message} tapToOpen={tapToOpen} amount={amount} exits={exits} />

      {stage === "choosing" ? (
        <>
          <PaymentMethods
            total={amount}
            isPaying={isPaying}
            allowCod={false}
            serverQr={false}
            onPay={(choice) => {
              void pay(handoff, choice).then((outcome) => {
                if (outcome === "paid") onPaid();
              });
            }}
          />
          <button
            type="button"
            onClick={onCancel}
            className="self-start text-xs font-medium text-clay-700 underline underline-offset-2 hover:text-ink"
          >
            Cancel — don&rsquo;t pay now
          </button>
        </>
      ) : null}
    </section>
  );
}
