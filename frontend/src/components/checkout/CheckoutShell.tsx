"use client";

import { imagesFor } from "@/lib/products/colourImages";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { ArrowLeft, Lock } from "lucide-react";

import { CheckoutSteps } from "@/components/checkout/CheckoutSteps";
import { CouponForm } from "@/components/cart/CouponForm";
import { MemberPerksNote } from "@/components/cart/MemberPerksNote";
import { OrderSummary } from "@/components/cart/OrderSummary";
import { ProductImage } from "@/components/common/ProductImage";
import { Skeleton } from "@/components/ui/Skeleton";
import { useCart } from "@/hooks/useCart";
import { useCustomerStatus } from "@/hooks/useSession";
import { formatPrice } from "@/lib/utils/format";

import type { BillingBreakdown, CartTotals, OrderLine } from "@/types";

/** One row of the side summary, from the bag or from a placed order. */
export interface SummaryLine {
  key: string;
  name: string;
  image?: string;
  detail: string;
  quantity: number;
  lineTotal: number;
}

/**
 * What the side panel shows once there is an order to show.
 *
 * Placing an order empties the bag, and finishing an earlier payment starts
 * with an empty one — so on the payment step the bag reads "0 items, ₹0" while
 * the customer is asked to pay the real amount. The order is what they are
 * paying for, so from then on the panel shows the order.
 */
export interface CheckoutSummary {
  lines: SummaryLine[];
  totals: CartTotals;
  breakdown: BillingBreakdown;
}

export function summaryLinesFromOrder(lines: OrderLine[]): SummaryLine[] {
  return lines.map((line, index) => ({
    key: `${line.productId}-${line.size ?? ""}-${line.color ?? ""}-${index}`,
    name: line.name,
    image: line.image,
    detail: [line.size, line.color].filter(Boolean).join(" · ") || line.brand,
    quantity: line.quantity,
    lineTotal: line.lineTotal,
  }));
}

/**
 * The frame every checkout step renders inside.
 *
 * It owns two things that would otherwise be repeated four times: the progress
 * indicator with the order summary, and the guard that sends anyone with an
 * empty bag back to the bag page. That guard runs after hydration, since the
 * bag is only knowable in the browser.
 */
export function CheckoutShell({
  title,
  description,
  suppressEmptyRedirect = false,
  detailedTax = false,
  summary,
  children,
}: {
  title: string;
  description?: string;
  /**
   * Turn off the empty-bag guard.
   *
   * Placing an order deliberately empties the bag, which would otherwise trip
   * the guard below and bounce the shopper to /cart instead of to their order
   * confirmation. The review step raises this for the duration of the submit.
   */
  suppressEmptyRedirect?: boolean;
  /**
   * Break the tax out into its CGST/SGST or IGST parts.
   *
   * Raised from the review step, where a shopper is about to commit and the
   * composition is worth showing. Earlier steps keep the single tax line, since
   * the place of supply is not settled until an address is entered.
   */
  detailedTax?: boolean;
  /**
   * Show an order instead of the bag. `null` while it loads; left out, the
   * panel shows the bag as on every earlier step.
   */
  summary?: CheckoutSummary | null;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const {
    lines,
    totals,
    breakdown,
    isLoading,
    isEmpty,
    bundles,
    coupon,
    couponCode,
    couponError,
    membership,
    applyCode,
    removeCode,
  } = useCart();
  const { isSignedIn, isPending } = useCustomerStatus();

  /**
   * Checkout needs an account, and says so before anything is filled in.
   *
   * The API already refuses an order without one — that is the boundary that
   * matters. This is what stops a shopper completing every step and only
   * then being told. They are sent to sign in with the step they were on as
   * `next`, and brought straight back to it afterwards, query string and all:
   * `/checkout/payment?payment=…` returns to that exact payment.
   *
   * Waits for the session check to finish, or a signed-in shopper with a
   * token still being confirmed would be bounced to sign in on every refresh.
   */
  const needsSignIn = !isPending && !isSignedIn;

  const shown: SummaryLine[] =
    summary?.lines ??
    lines.map((line) => ({
      key: line.lineId,
      name: line.product.name,
      image: imagesFor(line.product, line.color)[0],
      detail: [line.size, line.color].filter(Boolean).join(" · ") || line.product.brand,
      quantity: line.quantity,
      lineTotal: line.lineTotal,
    }));

  useEffect(() => {
    if (!needsSignIn) return;
    const here = `${pathname ?? "/checkout"}${searchParams?.size ? `?${searchParams}` : ""}`;
    router.replace(`/account?next=${encodeURIComponent(here)}`);
  }, [needsSignIn, pathname, searchParams, router]);

  useEffect(() => {
    // Only once signed in — a guest's empty bag is not the reason to leave.
    if (needsSignIn || isPending) return;
    if (isEmpty && !suppressEmptyRedirect) router.replace("/cart");
  }, [needsSignIn, isPending, isEmpty, suppressEmptyRedirect, router]);

  return (
    <div className="page-shell py-8 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Link
          href="/cart"
          className="inline-flex items-center gap-2 text-sm text-ink-700 transition-colors hover:text-copper-700"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
          Back to bag
        </Link>

        <CheckoutSteps />
      </div>

      <div className="mt-8 grid items-start gap-10 lg:grid-cols-[1fr_22rem] lg:gap-14">
        <div className="min-w-0">
          <h1 className="font-display text-[1.625rem] leading-tight text-ink sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-2.5 max-w-prose text-sm leading-relaxed text-ink-500">
              {description}
            </p>
          ) : null}

          <div className="mt-8">{children}</div>
        </div>

        {/* ------------------------------------------------- order summary */}
        <div className="lg:sticky lg:top-28">
          {/*
            The coupon box, on every step until the order is placed — it used
            to exist only in the bag, so a shopper who went straight to
            checkout had nowhere to enter a code.
          */}
          {summary === undefined && !isLoading && (lines.length > 0 || bundles.length > 0) ? (
            <div className="mb-4 rounded-card border border-ink-200 bg-shell p-4">
              <CouponForm
                compact
                applied={coupon}
                subtotal={totals.subtotal}
                onApply={applyCode}
                onRemove={removeCode}
                pendingCode={couponCode}
                error={couponError}
              />
            </div>
          ) : null}

          {summary === null || (summary === undefined && isLoading) ? (
            <Skeleton className="h-80 w-full" />
          ) : (
            <OrderSummary
              breakdown={summary?.breakdown ?? breakdown}
              totals={summary?.totals ?? totals}
              detailedTax={detailedTax}
            >
              <ul className="flex flex-col gap-3">
                {shown.map((line) => (
                  <li key={line.key} className="flex items-center gap-3">
                    <ProductImage
                      src={line.image}
                      alt=""
                      sizes="56px"
                      wrapperClassName="h-16 w-14 shrink-0 rounded-card"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-ink">{line.name}</p>
                      <p className="mt-0.5 text-[0.6875rem] text-ink-400">
                        {line.detail}
                        {" · "}
                        Qty {line.quantity}
                      </p>
                    </div>
                    <p className="shrink-0 text-xs text-ink tabular-nums">
                      {formatPrice(line.lineTotal)}
                    </p>
                  </li>
                ))}
              </ul>
            </OrderSummary>
          )}

          {summary === undefined && !isLoading ? (
            <div className="mt-4">
              <MemberPerksNote membership={membership} />
            </div>
          ) : null}

          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-ink-400">
            <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
            Secure checkout · your details are encrypted
          </p>
        </div>
      </div>
    </div>
  );
}
