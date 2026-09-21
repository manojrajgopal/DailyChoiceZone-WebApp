"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Info } from "lucide-react";

import type { PaymentMethodId } from "@/types";

import { CheckoutShell } from "@/components/checkout/CheckoutShell";
import { Button } from "@/components/ui/Button";
import { Radio } from "@/components/ui/Field";
import { useCheckoutHydrated } from "@/hooks/useStoreHydrated";
import { PAYMENT_METHODS } from "@/services/orderService";
import { useCheckoutStore } from "@/store/checkoutStore";

/**
 * Step 3 — payment method.
 *
 * Deliberately collects no payment credentials. There is no gateway behind
 * this, so asking for a card number would mean putting real card data into a
 * demo with nowhere safe to send it. The shopper picks a *method*; the real
 * integration would hand off to the provider's own hosted fields from here,
 * which is also how it should work in production.
 */
export default function CheckoutPaymentPage() {
  const router = useRouter();
  const checkoutHydrated = useCheckoutHydrated();

  const contact = useCheckoutStore((state) => state.contact);
  const address = useCheckoutStore((state) => state.address);
  const paymentMethodId = useCheckoutStore((state) => state.paymentMethodId);
  const setPaymentMethod = useCheckoutStore((state) => state.setPaymentMethod);

  // Earlier steps are prerequisites; send deep-links back to the first gap.
  // Waits for rehydration, or a refresh would discard a valid checkout.
  useEffect(() => {
    if (!checkoutHydrated) return;
    if (!contact.email) router.replace("/checkout");
    else if (!address) router.replace("/checkout/address");
  }, [checkoutHydrated, contact.email, address, router]);

  return (
    <CheckoutShell
      title="Payment method"
      description="Choose how you would like to pay. You will confirm everything on the next step."
    >
      <fieldset className="max-w-2xl">
        <legend className="sr-only">Payment method</legend>

        <div className="flex flex-col gap-2.5">
          {PAYMENT_METHODS.map((method) => (
            <Radio
              key={method.id}
              name="payment"
              value={method.id}
              checked={paymentMethodId === method.id}
              onChange={() => setPaymentMethod(method.id as PaymentMethodId)}
              label={method.name}
              description={method.description}
            />
          ))}
        </div>
      </fieldset>

      <div className="mt-6 flex max-w-2xl items-start gap-3 rounded-card border border-copper-200 bg-copper-50 p-4">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-copper-700" strokeWidth={1.75} aria-hidden="true" />
        <div className="text-xs leading-relaxed text-ink-700">
          <p className="font-medium text-ink">No payment will be taken</p>
          <p className="mt-1">
            This storefront has no payment gateway connected, so no card, UPI or bank details are
            requested, stored or transmitted. Placing the order creates a sample order record in
            this browser only.
          </p>
        </div>
      </div>

      <Button
        size="lg"
        className="mt-8 sm:w-auto"
        fullWidth
        onClick={() => router.push("/checkout/review")}
      >
        Review order
      </Button>
    </CheckoutShell>
  );
}
