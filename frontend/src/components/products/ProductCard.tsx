"use client";

import Link from "next/link";
import { useState } from "react";
import { Eye, Heart } from "lucide-react";

import type { Product } from "@/types";

import { ProductImage } from "@/components/common/ProductImage";
import { Badge } from "@/components/ui/Badge";
import { Price } from "@/components/ui/Price";
import { Rating } from "@/components/ui/Rating";
import { useWishlistItem } from "@/hooks/useWishlist";
import { cn } from "@/lib/utils/cn";
import { humanize } from "@/lib/utils/format";

import { QuickViewDialog } from "./QuickViewDialog";

export interface ProductCardProps {
  product: Product;
  /** Load the image eagerly. Use for the first row only. */
  priority?: boolean;
  /** Hide the quick-view affordance, e.g. inside the quick-view dialog itself. */
  showQuickView?: boolean;
  sizes?: string;
  className?: string;
}

/**
 * The product card.
 *
 * A few decisions worth naming:
 *
 * - The whole card is one link, with the image and title inside it, so the hit
 *   area is generous. The wishlist and quick-view buttons sit *outside* that
 *   link in the DOM to avoid nesting interactive elements, which is invalid and
 *   breaks keyboard behaviour.
 * - Hovering swaps to the second photograph. That is the single most effective
 *   detail in premium fashion retail, and it costs nothing: the second image is
 *   stacked underneath and revealed by opacity, so there is no layout shift.
 * - Action buttons are revealed on hover at desktop widths but always visible
 *   on touch, where there is no hover to reveal them.
 */
export function ProductCard({
  product,
  priority = false,
  showQuickView = true,
  sizes,
  className,
}: ProductCardProps) {
  const [quickViewOpen, setQuickViewOpen] = useState(false);
  const { isWishlisted, toggle } = useWishlistItem(product.id);

  const primaryImage = product.images[0];
  const hoverImage = product.images[1];
  const outOfStock = product.stock <= 0;

  return (
    <>
      <article className={cn("group relative flex flex-col", className)}>
        {/* ---------------------------------------------------------- media */}
        <div className="relative overflow-hidden bg-cream-deep">
          <Link
            href={`/product/${product.slug}`}
            className="block focus-visible:outline-offset-4"
            tabIndex={-1}
            aria-hidden="true"
          >
            <ProductImage
              src={primaryImage}
              alt=""
              priority={priority}
              sizes={sizes}
              wrapperClassName="aspect-[3/4] w-full"
              className={cn(
                "transition-transform duration-500 ease-brand",
                // With no second photograph there is nothing to cross-fade to,
                // so the hover affordance is a gentle push-in instead.
                !hoverImage && "group-hover:scale-[1.04]",
                outOfStock && "opacity-60 saturate-50",
              )}
            />

            {hoverImage ? (
              /*
               * The second photograph sits on top and fades in on hover.
               *
               * The fade has to be on the *wrapper*, not the inner image:
               * every ProductImage wrapper carries an opaque placeholder
               * background, so fading only the image would leave that
               * background covering the primary photograph at rest — which
               * showed up as a blank card until you hovered it.
               *
               * The primary image underneath stays fully opaque, so the
               * cross-fade never lets the card background show through.
               */
              <ProductImage
                src={hoverImage}
                alt=""
                sizes={sizes}
                wrapperClassName="absolute inset-0 opacity-0 transition-opacity duration-500 ease-brand group-hover:opacity-100"
                className="scale-[1.02] transition-transform duration-500 ease-brand group-hover:scale-100"
              />
            ) : null}
          </Link>

          {/* --- badges --- */}
          <div className="pointer-events-none absolute left-2.5 top-2.5 flex flex-col items-start gap-1.5">
            {outOfStock ? (
              <Badge tone="soldout">Sold out</Badge>
            ) : (
              <>
                {product.isNew ? <Badge tone="new">New</Badge> : null}
                {product.isBestSeller ? <Badge tone="bestseller">Bestseller</Badge> : null}
                {product.discount >= 25 ? (
                  <Badge tone="sale">{product.discount}% off</Badge>
                ) : null}
              </>
            )}
          </div>

          {/* --- actions: outside the link, so no nested interactives --- */}
          <div
            className={cn(
              // z-2 keeps these above the title link's stretched overlay (z-1),
              // which would otherwise swallow their clicks.
              "absolute right-2.5 top-2.5 z-[2] flex flex-col gap-1.5",
              "opacity-100 transition-opacity duration-200 ease-brand",
              // Revealed on hover where hover exists; always shown on touch.
              "lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100",
            )}
          >
            <button
              type="button"
              onClick={() => toggle(product.name)}
              aria-label={
                isWishlisted
                  ? `Remove ${product.name} from wishlist`
                  : `Save ${product.name} to wishlist`
              }
              aria-pressed={isWishlisted}
              className="inline-flex h-9 w-9 items-center justify-center rounded-pill bg-shell/90 text-ink shadow-subtle backdrop-blur-sm transition-colors hover:bg-shell"
            >
              <Heart
                className={cn(
                  "h-4 w-4 transition-colors",
                  isWishlisted ? "fill-clay-500 text-clay-500 animate-pop" : "text-ink",
                )}
                strokeWidth={1.5}
              />
            </button>

            {showQuickView ? (
              <button
                type="button"
                onClick={() => setQuickViewOpen(true)}
                aria-label={`Quick view: ${product.name}`}
                className="hidden h-9 w-9 items-center justify-center rounded-pill bg-shell/90 text-ink shadow-subtle backdrop-blur-sm transition-colors hover:bg-shell lg:inline-flex"
              >
                <Eye className="h-4 w-4" strokeWidth={1.5} />
              </button>
            ) : null}
          </div>
        </div>

        {/* ---------------------------------------------------------- detail */}
        <div className="flex flex-1 flex-col gap-1.5 pt-3">
          <p className="label-wide text-ink-400">{humanize(product.subcategory)}</p>

          <h3 className="text-[0.9375rem] leading-snug text-ink">
            {/* The one real link — its text is the accessible name for the card. */}
            <Link
              href={`/product/${product.slug}`}
              className="transition-colors hover:text-copper-700"
            >
              {/* Stretches the link's hit area over the whole card. */}
              <span className="absolute inset-0 z-[1]" aria-hidden="true" />
              {product.name}
            </Link>
          </h3>

          <p className="text-xs text-ink-500">{product.brand}</p>

          <Price
            price={product.price}
            originalPrice={product.originalPrice}
            discount={product.discount}
            size="sm"
            className="mt-0.5"
          />

          {product.reviewCount > 0 ? (
            <Rating
              value={product.rating}
              reviewCount={product.reviewCount}
              showValue={false}
              className="mt-0.5"
            />
          ) : null}
        </div>
      </article>

      {showQuickView ? (
        <QuickViewDialog
          product={product}
          open={quickViewOpen}
          onOpenChange={setQuickViewOpen}
        />
      ) : null}
    </>
  );
}
