"use client";

import Link from "next/link";
import { ArrowLeft, Lock } from "lucide-react";

import { CartBundleRow } from "@/components/cart/CartBundleRow";
import { CartLineRow } from "@/components/cart/CartLineRow";
import { CartRecoveryNotice } from "@/components/cart/CartRecoveryNotice";
import { MemberPerksNote } from "@/components/cart/MemberPerksNote";
import { CouponForm } from "@/components/cart/CouponForm";
import { OrderSummary } from "@/components/cart/OrderSummary";
import { SavedForLaterSection } from "@/components/cart/SavedForLaterSection";
import { EmptyState } from "@/components/common/States";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { ButtonLink } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useCart } from "@/hooks/useCart";
import { useSavedForLater } from "@/hooks/useSavedForLater";

/**
 * The shopping bag.
 *
 * A client page, because the bag lives in local storage. Note the checkout
 * button is blocked while any line is out of stock — letting someone reach
 * payment with an unbuyable item in the bag is worse than blocking early and
 * saying why.
 */
export function CartView() {
  const {
    lines,
    totals,
    breakdown,
    coupon,
    couponCode,
    couponError,
    membership,
    isLoading,
    isEmpty,
    remove,
    setQuantity,
    applyCode,
    removeCode,
    refresh,
    bundles,
    issues,
    setBundleQuantity,
    removeBundle,
    applyServerCart,
  } = useCart();
  // "Not now": lines put aside, below the bag. Moving one either way redraws
  // both from the one answer the server gives.
  const saved = useSavedForLater({ onCart: applyServerCart });
  const savedSection = (
    <SavedForLaterSection
      entries={saved.entries}
      isLoading={saved.isLoading}
      failed={saved.failed}
      busy={saved.busy}
      onMoveToCart={(entry) => void saved.moveToCart(entry)}
      onRemove={(entry) => void saved.remove(entry)}
      onClear={saved.clear}
      onRetry={saved.refresh}
    />
  );

  const hasOutOfStock = lines.some((line) => line.product.stock <= 0);
  // A flash sale limit or a bundle that can't be bought stops checkout; said here first.
  const blocked = hasOutOfStock || issues.length > 0;

  return (
    <div className="page-shell py-8 sm:py-10">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Shopping bag" }]} />

      <h1 className="mt-4 font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">
        Shopping bag
        {!isLoading && totals.itemCount > 0 ? (
          <span className="ml-3 align-middle text-base font-normal text-ink-400 tabular-nums">
            {totals.itemCount} {totals.itemCount === 1 ? "item" : "items"}
          </span>
        ) : null}
      </h1>

      <CartRecoveryNotice onRestored={refresh} />

      {isLoading ? (
        <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_22rem]">
          <div className="flex flex-col gap-5">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex gap-4">
                <Skeleton className="h-32 w-24 sm:h-36 sm:w-28" />
                <div className="flex flex-1 flex-col gap-2.5 py-1">
                  <Skeleton className="h-2.5 w-20" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="mt-auto h-8 w-28" />
                </div>
              </div>
            ))}
          </div>
          <Skeleton className="h-72 w-full" />
        </div>
      ) : isEmpty ? (
        <>
          <EmptyState
            title="Your bag is empty"
            description={saved.count > 0
              ? "Your saved items are below — move any of them back when you're ready."
              : "Once you find something you like, it will show up here. Delivery is free on orders above ₹999."}
            action={{ label: "Start shopping", href: "/shop" }}
            className="mt-4"
          />
          {savedSection}
        </>
      ) : (
        <div className="mt-8 grid items-start gap-10 lg:grid-cols-[1fr_22rem] lg:gap-14">
          {/* ------------------------------------------------------- lines */}
          <div>
            <ul className="flex flex-col divide-y divide-ink-100 border-y border-ink-200">
              {lines.map((line) => (
                <CartLineRow
                  key={line.lineId}
                  line={line}
                  onQuantityChange={setQuantity}
                  onRemove={remove}
                  onSaveForLater={(entry) => void saved.saveLine(entry)}
                  saving={saved.busy === `c-${line.lineId}`}
                />
              ))}
              {bundles.map((bundle) => (
                <CartBundleRow key={`b-${bundle.id}`} bundle={bundle} onQuantityChange={(id, q) => void setBundleQuantity(id, q)}
                  onRemove={(id, name) => void removeBundle(id, name)} />
              ))}
            </ul>

            <Link
              href="/shop"
              className="mt-6 inline-flex items-center gap-2 text-sm text-ink-700 transition-colors hover:text-copper-700"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
              Continue shopping
            </Link>

            {savedSection}
          </div>

          {/* ----------------------------------------------------- summary */}
          <div className="flex flex-col gap-4 lg:sticky lg:top-28">
            <CouponForm
              applied={coupon}
              subtotal={totals.subtotal}
              onApply={applyCode}
              onRemove={removeCode}
              pendingCode={couponCode}
              error={couponError}
            />

            <OrderSummary breakdown={breakdown} totals={totals} />

            <MemberPerksNote membership={membership} />

            {blocked ? (
              <div className="rounded-card border border-danger/30 bg-danger-bg p-3.5" role="alert">
                {hasOutOfStock ? (
                  <p className="text-sm text-danger">
                    One or more items in your bag are out of stock. Remove them to continue.
                  </p>
                ) : null}
                {issues.map((issue) => (
                  <p key={`${issue.code}-${issue.cartItemId ?? issue.cartBundleId ?? issue.productId}`} className="text-sm text-danger">
                    {issue.message}
                  </p>
                ))}
              </div>
            ) : (
              <ButtonLink href="/checkout" size="lg" fullWidth>
                <Lock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Proceed to checkout
              </ButtonLink>
            )}

            <p className="text-center text-xs text-ink-400">
              Taxes included. Delivery calculated at checkout.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
