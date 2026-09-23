"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ArrowLeft, Lock } from "lucide-react";

import { CheckoutSteps } from "@/components/checkout/CheckoutSteps";
import { OrderSummary } from "@/components/cart/OrderSummary";
import { ProductImage } from "@/components/common/ProductImage";
import { Skeleton } from "@/components/ui/Skeleton";
import { useCart } from "@/hooks/useCart";
import { formatPrice } from "@/lib/utils/format";

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
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { lines, totals, breakdown, isLoading, isEmpty } = useCart();

  useEffect(() => {
    if (isEmpty && !suppressEmptyRedirect) router.replace("/cart");
  }, [isEmpty, suppressEmptyRedirect, router]);

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
          {isLoading ? (
            <Skeleton className="h-80 w-full" />
          ) : (
            <OrderSummary breakdown={breakdown} totals={totals} detailedTax={detailedTax}>
              <ul className="flex flex-col gap-3">
                {lines.map((line) => (
                  <li key={line.lineId} className="flex items-center gap-3">
                    <ProductImage
                      src={line.product.images[0]}
                      alt=""
                      sizes="56px"
                      wrapperClassName="h-16 w-14 shrink-0 rounded-card"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-ink">{line.product.name}</p>
                      <p className="mt-0.5 text-[0.6875rem] text-ink-400">
                        {[line.size, line.color].filter(Boolean).join(" · ") || line.product.brand}
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

          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-ink-400">
            <Lock className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
            This is a demo checkout — no payment is taken
          </p>
        </div>
      </div>
    </div>
  );
}
