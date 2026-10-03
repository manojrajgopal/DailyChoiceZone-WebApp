"use client";

import Link from "next/link";
import { useState } from "react";
import { ShoppingBag, Trash2, TrendingDown } from "lucide-react";

import type { SavedEntry } from "@/hooks/useSavedForLater";

import { ProductImage } from "@/components/common/ProductImage";
import { StockAlertButton } from "@/components/products/ProductAlerts";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmModal } from "@/components/ui/ConfirmModal";
import { Price } from "@/components/ui/Price";
import { Skeleton } from "@/components/ui/Skeleton";
import { imagesFor, productHref } from "@/lib/products/colourImages";
import { formatDate, formatPrice } from "@/lib/utils/format";

/**
 * "Saved for later", under the bag.
 *
 * Every line shows today's price and whether it can go back in the bag as it
 * is. A line that can't — sold out, the size withdrawn, the product taken off
 * sale — says so and offers what it can (remove, or "notify me" when it's only
 * out of stock); it is never moved back automatically.
 */
export function SavedForLaterSection({
  entries,
  isLoading,
  failed,
  busy,
  onMoveToCart,
  onRemove,
  onClear,
  onRetry,
  heading = "Saved for later",
  headingLevel: Heading = "h2",
}: {
  entries: SavedEntry[];
  isLoading: boolean;
  failed?: boolean;
  busy: string | null;
  onMoveToCart: (entry: SavedEntry) => void;
  onRemove: (entry: SavedEntry) => void;
  onClear: () => void | Promise<void>;
  onRetry?: () => void;
  heading?: string;
  headingLevel?: "h1" | "h2";
}) {
  const [confirming, setConfirming] = useState(false);

  if (isLoading && entries.length === 0) {
    return (
      <section aria-busy="true" aria-label="Loading saved items" className="mt-12">
        <Skeleton className="h-6 w-40" />
        <div className="mt-5 flex flex-col gap-4">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </section>
    );
  }

  if (failed) {
    return (
      <section className="mt-12" role="alert">
        <p className="text-sm text-danger">We couldn&apos;t load your saved items.</p>
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </section>
    );
  }

  if (entries.length === 0) return null;

  return (
    <section aria-labelledby="saved-for-later-heading" className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Heading id="saved-for-later-heading" className="font-display text-xl text-ink sm:text-2xl">
          {heading}
          <span className="ml-2.5 align-middle text-sm font-normal text-ink-400 tabular-nums">
            {entries.length} {entries.length === 1 ? "item" : "items"}
          </span>
        </Heading>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-xs text-ink-500 underline-offset-2 transition-colors hover:text-danger hover:underline"
        >
          Remove all
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-500">
        Not in your bag, and not reserved — prices and stock are as they are today.
      </p>

      <ul className="mt-5 flex flex-col divide-y divide-ink-100 border-y border-ink-200">
        {entries.map((entry) => (
          <SavedRow
            key={entry.key}
            entry={entry}
            busy={busy === entry.key}
            onMoveToCart={onMoveToCart}
            onRemove={onRemove}
          />
        ))}
      </ul>

      <ConfirmModal
        open={confirming}
        onOpenChange={setConfirming}
        title="Remove every saved item?"
        message="They'll be taken off your saved list. Your bag and your wishlist aren't affected."
        confirmLabel="Remove all"
        onConfirm={onClear}
      />
    </section>
  );
}

function SavedRow({
  entry,
  busy,
  onMoveToCart,
  onRemove,
}: {
  entry: SavedEntry;
  busy: boolean;
  onMoveToCart: (entry: SavedEntry) => void;
  onRemove: (entry: SavedEntry) => void;
}) {
  const { product } = entry;
  const withdrawn = entry.status === "unavailable";
  const href = productHref(product, entry.color);

  return (
    <li className="flex gap-4 py-5">
      {withdrawn ? (
        <ProductImage src={imagesFor(product, entry.color)[0]} alt="" sizes="96px"
          wrapperClassName="h-28 w-20 shrink-0 rounded-card opacity-60 sm:h-32 sm:w-24" />
      ) : (
        <Link href={href} className="shrink-0" aria-label={product.name} tabIndex={-1}>
          <ProductImage src={imagesFor(product, entry.color)[0]} alt="" sizes="96px"
            wrapperClassName="h-28 w-20 rounded-card sm:h-32 sm:w-24" />
        </Link>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[0.9375rem] leading-snug text-ink">
              {withdrawn ? product.name : (
                <Link href={href} className="transition-colors hover:text-copper-700">{product.name}</Link>
              )}
            </h3>
            <p className="mt-0.5 text-xs text-ink-500">{product.brand}</p>
            <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-500">
              {entry.size ? <span>Size: {entry.size}</span> : null}
              {entry.color ? <span>Colour: {entry.color}</span> : null}
              <span>Qty: {entry.quantity}</span>
              {typeof entry.savedAt === "string" ? <span>Saved {formatDate(entry.savedAt)}</span> : null}
            </p>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {entry.status === "available" ? <Badge tone="stock">In stock</Badge> : null}
              {entry.status === "limited" ? <Badge tone="sale">{entry.message}</Badge> : null}
              {entry.status === "out-of-stock" || entry.status === "unavailable" ? (
                <Badge tone="soldout">Currently unavailable</Badge>
              ) : null}
              {entry.status === "variant-unavailable" ? <Badge tone="soldout">{entry.message}</Badge> : null}
              {entry.inWishlist ? <Badge tone="neutral">Also in your wishlist</Badge> : null}
            </div>
            {entry.priceDrop ? (
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-sage-600">
                <TrendingDown className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                Price dropped from {formatPrice(entry.priceDrop.from)} to {formatPrice(entry.priceDrop.to)}
              </p>
            ) : null}
          </div>

          {!withdrawn ? (
            <div className="shrink-0 text-right">
              <Price price={entry.unitPrice} originalPrice={product.originalPrice} discount={product.discount}
                size="sm" />
            </div>
          ) : null}
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          {entry.canMoveToCart ? (
            <Button size="sm" onClick={() => onMoveToCart(entry)} disabled={busy} aria-busy={busy}>
              <ShoppingBag className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              {busy ? "Moving…" : "Move to bag"}
            </Button>
          ) : entry.status === "out-of-stock" ? (
            <div className="min-w-[10rem]">
              <StockAlertButton product={product} size={entry.size} color={entry.color} />
            </div>
          ) : entry.status === "variant-unavailable" ? (
            <Link href={href} className="text-xs text-copper-700 underline underline-offset-2 hover:text-ink">
              Choose another option
            </Link>
          ) : null}

          {!withdrawn ? (
            <Link href={href} className="px-2 text-xs text-ink-500 underline-offset-2 hover:text-ink hover:underline">
              View product
            </Link>
          ) : null}

          <button
            type="button"
            onClick={() => onRemove(entry)}
            disabled={busy}
            className="ml-auto inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-xs text-ink-500 transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-50"
            aria-label={`Remove ${product.name} from saved for later`}
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
            Remove
          </button>
        </div>
      </div>
    </li>
  );
}
