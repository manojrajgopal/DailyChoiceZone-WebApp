"use client";

import { imagesFor, productHref } from "@/lib/products/colourImages";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Pencil } from "lucide-react";

import { CheckoutShell } from "@/components/checkout/CheckoutShell";
import { ProductImage } from "@/components/common/ProductImage";
import { Button } from "@/components/ui/Button";
import { useCart } from "@/hooks/useCart";
import { useCheckoutHydrated } from "@/hooks/useStoreHydrated";
import { formatPrice } from "@/lib/utils/format";
import { getDeliveryMethod } from "@/services/orderService";
import { useCheckoutStore } from "@/store/checkoutStore";

/** Step 4 — confirm everything, then place the order. */
export default function CheckoutReviewPage() {
  const router = useRouter();
  const checkoutHydrated = useCheckoutHydrated();
  const { lines, totals, bundles } = useCart();

  const contact = useCheckoutStore((state) => state.contact);
  const address = useCheckoutStore((state) => state.address);
  const billingSame = useCheckoutStore((state) => state.billingSameAsShipping);
  const storedBilling = useCheckoutStore((state) => state.billingAddress);
  const deliveryMethodId = useCheckoutStore((state) => state.deliveryMethodId);



  /**
   * Prerequisite guard for deep links.
   *
   * Waits for rehydration, or a refresh would discard a valid checkout. This
   * step no longer places the order — the payment step does — so there is no
   * in-flight submit to make an exception for.
   */
  useEffect(() => {
    if (!checkoutHydrated) return;
    if (!contact.email) router.replace("/checkout");
    else if (!address) router.replace("/checkout/address");
  }, [checkoutHydrated, contact.email, address, router]);

  const deliveryMethod = getDeliveryMethod(deliveryMethodId);

  const onContinue = () => router.push("/checkout/payment");

  // Nothing to review yet.
  if (!address) return null;

  return (
    <CheckoutShell
      title="Review your order"
      description="One last look before it goes to our warehouse."
      // About to commit: show how the tax splits.
      detailedTax
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

        <ReviewCard title="Billing address" editHref="/checkout/address">
          {billingSame || !storedBilling ? (
            <p>Same as the delivery address.</p>
          ) : (
            <>
              <p className="font-medium text-ink">{storedBilling.fullName}</p>
              <p className="mt-0.5">
                {storedBilling.line1}
                {storedBilling.line2 ? `, ${storedBilling.line2}` : ""}
              </p>
              <p className="mt-0.5">
                {storedBilling.city}, {storedBilling.state} {storedBilling.postalCode}
              </p>
              <p className="mt-0.5">{storedBilling.email}</p>
            </>
          )}
        </ReviewCard>

        <ReviewCard title="Delivery method" editHref="/checkout/address">
          <p className="font-medium text-ink">{deliveryMethod.name}</p>
          <p className="mt-0.5">
            {deliveryMethod.estimate}
            {totals.deliveryFee === 0 ? " · Free" : ` · ${formatPrice(totals.deliveryFee)}`}
          </p>
        </ReviewCard>


        {/* ------------------------------------------------------ the items */}
        <div className="rounded-card border border-ink-200 bg-shell p-4">
          <h2 className="label-wide text-ink">
            {totals.itemCount} {totals.itemCount === 1 ? "item" : "items"}
          </h2>

          <ul className="mt-4 flex flex-col divide-y divide-ink-100">
            {lines.map((line) => (
              <li key={line.lineId} className="flex items-center gap-3.5 py-3 first:pt-0">
                <Link href={productHref(line.product, line.color)} className="shrink-0" tabIndex={-1}>
                  <ProductImage
                    src={imagesFor(line.product, line.color)[0]}
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
            {bundles.map((bundle) => (
              <li key={`b-${bundle.id}`} className="flex items-center gap-3.5 py-3 first:pt-0">
                <ProductImage src={bundle.image} alt="" sizes="64px" wrapperClassName="h-20 w-16 shrink-0 rounded-card" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">{bundle.name} <span className="text-xs text-copper-700">· bundle</span></p>
                  <p className="mt-0.5 text-xs text-ink-500">{bundle.components.map((c) => `${c.quantity > 1 ? `${c.quantity} × ` : ""}${c.name}${c.size ? ` (${c.size})` : ""}`).join(", ")}</p>
                  <p className="mt-1 text-xs text-ink-400">Qty {bundle.quantity}</p>
                </div>
                <p className="shrink-0 text-sm text-ink tabular-nums">{formatPrice(bundle.lineTotal / 100)}</p>
              </li>
            ))}
          </ul>
        </div>

        <Button size="lg" onClick={onContinue} disabled={lines.length === 0 && bundles.length === 0} fullWidth>
          Continue to payment · {formatPrice(totals.total)}
        </Button>

        <p className="text-center text-xs leading-relaxed text-ink-400">
          By continuing you agree to our{" "}
          <Link href="/terms" className="underline underline-offset-2 hover:text-ink">
            terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-ink">
            privacy policy
          </Link>
          . Your order is placed on the next step, when you pay.
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
