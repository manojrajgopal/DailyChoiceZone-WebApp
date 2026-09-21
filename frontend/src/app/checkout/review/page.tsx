"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2, Pencil } from "lucide-react";

import { CheckoutShell } from "@/components/checkout/CheckoutShell";
import { ProductImage } from "@/components/common/ProductImage";
import { Button } from "@/components/ui/Button";
import { useCart } from "@/hooks/useCart";
import { useCheckoutHydrated } from "@/hooks/useStoreHydrated";
import { formatPrice } from "@/lib/utils/format";
import { saveAddress } from "@/services/accountService";
import {
  getDeliveryMethod,
  getPaymentMethod,
  placeOrder,
} from "@/services/orderService";
import { useCheckoutStore } from "@/store/checkoutStore";
import { toast } from "@/store/toastStore";

/** Step 4 — confirm everything, then place the order. */
export default function CheckoutReviewPage() {
  const router = useRouter();
  const checkoutHydrated = useCheckoutHydrated();
  const { lines, totals, clear } = useCart();

  const contact = useCheckoutStore((state) => state.contact);
  const address = useCheckoutStore((state) => state.address);
  const deliveryMethodId = useCheckoutStore((state) => state.deliveryMethodId);
  const paymentMethodId = useCheckoutStore((state) => state.paymentMethodId);
  const resetCheckout = useCheckoutStore((state) => state.reset);

  const [isPlacing, setIsPlacing] = useState(false);

  /**
   * Prerequisite guard for deep links.
   *
   * Skipped in two cases: before the store has rehydrated (or a refresh would
   * discard a valid checkout), and once a submit is in flight (because
   * clearing the store is part of placing the order, and must not be mistaken
   * for someone arriving here with nothing filled in).
   */
  useEffect(() => {
    if (!checkoutHydrated || isPlacing) return;
    if (!contact.email) router.replace("/checkout");
    else if (!address) router.replace("/checkout/address");
  }, [checkoutHydrated, contact.email, address, isPlacing, router]);

  const deliveryMethod = getDeliveryMethod(deliveryMethodId);
  const paymentMethod = getPaymentMethod(paymentMethodId);

  const onPlaceOrder = async () => {
    if (!address || lines.length === 0) return;

    setIsPlacing(true);
    try {
      const order = await placeOrder({
        lines,
        totals,
        address: { ...address, id: `addr_${Date.now()}` },
        deliveryMethod,
        paymentMethod,
        email: contact.email,
      });

      // Keep the address for next time, then clear the transient state.
      await saveAddress(address);
      clear();
      resetCheckout();

      router.push(`/order-success?order=${encodeURIComponent(order.orderNumber)}`);
    } catch {
      toast.error("We could not place your order. Please try again.");
      setIsPlacing(false);
    }
  };

  // Nothing to review yet, or the store has just been cleared post-submit.
  if (!address) return null;

  return (
    <CheckoutShell
      title="Review your order"
      description="One last look before it goes to our warehouse."
      // Placing the order empties the bag on purpose; without this the
      // empty-bag guard would redirect away from the confirmation page.
      suppressEmptyRedirect={isPlacing}
    >
      <div className="flex max-w-2xl flex-col gap-4">
        <ReviewCard title="Contact" editHref="/checkout">
          <p>{contact.email}</p>
          <p className="mt-0.5">+91 {contact.phone}</p>
        </ReviewCard>

        <ReviewCard title="Delivery address" editHref="/checkout/address">
          <p className="font-medium text-ink">{address.fullName}</p>
          <p className="mt-0.5">
            {address.line1}
            {address.line2 ? `, ${address.line2}` : ""}
          </p>
          <p className="mt-0.5">
            {address.city}, {address.state} {address.pincode}
          </p>
          <p className="mt-0.5">+91 {address.phone}</p>
        </ReviewCard>

        <ReviewCard title="Delivery method" editHref="/checkout/address">
          <p className="font-medium text-ink">{deliveryMethod.name}</p>
          <p className="mt-0.5">
            {deliveryMethod.estimate}
            {totals.deliveryFee === 0 ? " · Free" : ` · ${formatPrice(totals.deliveryFee)}`}
          </p>
        </ReviewCard>

        <ReviewCard title="Payment method" editHref="/checkout/payment">
          <p className="font-medium text-ink">{paymentMethod.name}</p>
          <p className="mt-0.5">{paymentMethod.description}</p>
        </ReviewCard>

        {/* ------------------------------------------------------ the items */}
        <div className="rounded-card border border-ink-200 bg-shell p-4">
          <h2 className="label-wide text-ink">
            {totals.itemCount} {totals.itemCount === 1 ? "item" : "items"}
          </h2>

          <ul className="mt-4 flex flex-col divide-y divide-ink-100">
            {lines.map((line) => (
              <li key={line.lineId} className="flex items-center gap-3.5 py-3 first:pt-0">
                <Link href={`/product/${line.product.slug}`} className="shrink-0" tabIndex={-1}>
                  <ProductImage
                    src={line.product.images[0]}
                    alt=""
                    sizes="64px"
                    wrapperClassName="h-20 w-16 rounded-card"
                  />
                </Link>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{line.product.name}</p>
                  <p className="mt-0.5 text-xs text-ink-500">{line.product.brand}</p>
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
        </div>

        <Button
          size="lg"
          onClick={onPlaceOrder}
          disabled={isPlacing || lines.length === 0}
          className="mt-2"
          fullWidth
        >
          {isPlacing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              Placing order…
            </>
          ) : (
            <>Place order · {formatPrice(totals.total)}</>
          )}
        </Button>

        <p className="text-center text-xs leading-relaxed text-ink-400">
          By placing this order you agree to our{" "}
          <Link href="/terms" className="underline underline-offset-2 hover:text-ink">
            terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-ink">
            privacy policy
          </Link>
          . No payment will be taken.
        </p>
      </div>
    </CheckoutShell>
  );
}

function ReviewCard({
  title,
  editHref,
  children,
}: {
  title: string;
  editHref: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card border border-ink-200 bg-shell p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="label-wide text-ink">{title}</h2>
        <Link
          href={editHref}
          className="inline-flex items-center gap-1.5 text-xs text-copper-700 transition-colors hover:text-ink"
        >
          <Pencil className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
          Edit
          <span className="sr-only"> {title.toLowerCase()}</span>
        </Link>
      </div>
      <div className="mt-2.5 text-sm leading-relaxed text-ink-700">{children}</div>
    </section>
  );
}
