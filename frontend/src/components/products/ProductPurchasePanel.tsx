"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Heart, RotateCcw, ShieldCheck, Truck } from "lucide-react";

import type { Product, SiteConfig } from "@/types";

import { ColorPicker, QuantityStepper, SizePicker } from "@/components/common/VariantPickers";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { Rating } from "@/components/ui/Rating";
import { useCart } from "@/hooks/useCart";
import { useHydrated } from "@/hooks/useHydrated";
import { useWishlistItem } from "@/hooks/useWishlist";
import { cn } from "@/lib/utils/cn";
import { deliveryEstimate, formatPrice, humanize } from "@/lib/utils/format";
import { toast } from "@/store/toastStore";

/**
 * The buy box.
 *
 * Holds the only genuinely stateful part of the product page: the chosen
 * variant. It refuses to add a sized product to the bag without a size, and
 * says so both visually and through a toast rather than silently doing
 * nothing — the most common frustration on a product page.
 */
export function ProductPurchasePanel({
  product,
  config,
}: {
  product: Product;
  config: SiteConfig;
}) {
  const router = useRouter();
  const { add } = useCart();

  /**
   * The arrival date is computed in the browser, never at build time.
   *
   * Product pages are prerendered, so a date baked in at build would be wrong
   * for every visitor after that day — and would disagree with what the client
   * computes, which is a hydration mismatch. Until hydration completes the
   * panel shows the delivery window instead of a specific date.
   */
  const hydrated = useHydrated();
  const arrivalDate = hydrated ? deliveryEstimate(5) : null;
  const { isWishlisted, toggle } = useWishlistItem(product.id);

  const [size, setSize] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(product.colors[0]?.name ?? null);
  const [quantity, setQuantity] = useState(1);
  const [sizeError, setSizeError] = useState(false);

  const needsSize = product.sizes.length > 0;
  const outOfStock = product.stock <= 0;
  const lowStock = !outOfStock && product.stock <= 5;

  const ensureVariant = () => {
    if (needsSize && !size) {
      setSizeError(true);
      toast.error("Please select a size first");
      return false;
    }
    return true;
  };

  const onAddToBag = () => {
    if (!ensureVariant()) return;
    add(product, { size, color, quantity });
  };

  const onBuyNow = () => {
    if (!ensureVariant()) return;
    add(product, { size, color, quantity });
    router.push("/checkout");
  };

  return (
    <div className="flex flex-col">
      <p className="label-wide text-ink-400">
        <Link
          href={`/category/${product.category}`}
          className="transition-colors hover:text-copper-700"
        >
          {humanize(product.category)}
        </Link>
        {" · "}
        <Link
          href={`/category/${product.category}?subcategory=${product.subcategory}`}
          className="transition-colors hover:text-copper-700"
        >
          {humanize(product.subcategory)}
        </Link>
      </p>

      <h1 className="mt-3 font-display text-2xl leading-tight text-ink sm:text-3xl">
        {product.name}
      </h1>

      <p className="mt-2 text-sm text-ink-500">
        by{" "}
        <Link
          href={`/shop?brand=${encodeURIComponent(product.brand)}`}
          className="text-ink-700 underline decoration-ink-300 underline-offset-2 transition-colors hover:text-copper-700"
        >
          {product.brand}
        </Link>
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Rating value={product.rating} reviewCount={product.reviewCount} />
        <a
          href="#reviews"
          className="text-xs text-copper-700 underline underline-offset-2 transition-colors hover:text-ink"
        >
          Read reviews
        </a>
      </div>

      <div className="mt-5 border-y border-ink-200 py-5">
        <Price
          price={product.price}
          originalPrice={product.originalPrice}
          discount={product.discount}
          size="lg"
        />
        <p className="mt-1.5 text-xs text-ink-400">Inclusive of all taxes</p>

        <div className="mt-3 flex flex-wrap gap-2">
          {outOfStock ? (
            <Badge tone="soldout">Out of stock</Badge>
          ) : lowStock ? (
            <Badge tone="sale">Only {product.stock} left</Badge>
          ) : (
            <Badge tone="stock">In stock</Badge>
          )}
          {product.isNew ? <Badge tone="new">New in</Badge> : null}
          {product.isBestSeller ? <Badge tone="bestseller">Bestseller</Badge> : null}
        </div>
      </div>

      {/* ------------------------------------------------------- variants */}
      {product.colors.length > 0 ? (
        <div className="mt-6">
          <p className="label-wide mb-2.5 text-ink-700">
            Colour
            {color ? <span className="ml-2 normal-case tracking-normal text-ink-400">{color}</span> : null}
          </p>
          <ColorPicker colors={product.colors} value={color} onChange={setColor} />
        </div>
      ) : null}

      {needsSize ? (
        <div className="mt-6">
          <div className="mb-2.5 flex items-center justify-between">
            <p className="label-wide text-ink-700">Size</p>
            <Link
              href="/faq#size-guide"
              className="text-xs text-copper-700 underline underline-offset-2 transition-colors hover:text-ink"
            >
              Size guide
            </Link>
          </div>
          <SizePicker
            sizes={product.sizes}
            value={size}
            onChange={(next) => {
              setSize(next);
              setSizeError(false);
            }}
            error={sizeError}
          />
          {sizeError ? (
            <p role="alert" className="mt-2 text-xs text-danger">
              Choose a size to continue.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 flex items-center gap-4">
        <p className="label-wide text-ink-700">Quantity</p>
        <QuantityStepper
          value={quantity}
          onChange={setQuantity}
          max={Math.max(1, product.stock)}
        />
      </div>

      {/* -------------------------------------------------------- actions */}
      <div className="mt-7 flex flex-col gap-2.5 sm:flex-row">
        <Button size="lg" onClick={onAddToBag} disabled={outOfStock} className="flex-1">
          {outOfStock ? "Out of stock" : "Add to bag"}
        </Button>

        <Button
          size="lg"
          variant="outline"
          onClick={onBuyNow}
          disabled={outOfStock}
          className="flex-1"
        >
          Buy now
        </Button>

        <Button
          size="lg"
          variant="ghost"
          onClick={() => toggle(product.name)}
          aria-pressed={isWishlisted}
          aria-label={isWishlisted ? "Remove from wishlist" : "Save to wishlist"}
          className="shrink-0 border border-ink-200 sm:w-14 sm:px-0"
        >
          <Heart
            className={cn("h-4 w-4", isWishlisted && "fill-clay-500 text-clay-500 animate-pop")}
            strokeWidth={1.5}
          />
          <span className="sm:hidden">
            {isWishlisted ? "Saved to wishlist" : "Save to wishlist"}
          </span>
        </Button>
      </div>

      {/* ---------------------------------------------- delivery and returns */}
      <dl className="mt-8 flex flex-col gap-3.5 rounded-card bg-cream-deep p-4">
        <div className="flex gap-3">
          <Truck className="mt-0.5 h-4 w-4 shrink-0 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
          <div>
            <dt className="text-sm font-medium text-ink">
              {product.price >= config.freeDeliveryThreshold
                ? "Free delivery"
                : `Delivery ${formatPrice(config.standardDeliveryFee)}`}
            </dt>
            <dd className="mt-0.5 text-xs leading-relaxed text-ink-500">
              {arrivalDate
                ? `Order today for arrival by ${arrivalDate}. `
                : "Arrives in 3–5 business days. "}
              Free over {formatPrice(config.freeDeliveryThreshold)}.
            </dd>
          </div>
        </div>

        <div className="flex gap-3">
          <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
          <div>
            <dt className="text-sm font-medium text-ink">
              {config.returnWindowDays}-day returns
            </dt>
            <dd className="mt-0.5 text-xs leading-relaxed text-ink-500">
              Unworn and with tags on. We arrange the pickup.
            </dd>
          </div>
        </div>

        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-copper-600" strokeWidth={1.5} aria-hidden="true" />
          <div>
            <dt className="text-sm font-medium text-ink">Quality checked</dt>
            <dd className="mt-0.5 text-xs leading-relaxed text-ink-500">
              Inspected by hand before dispatch. SKU {product.sku}.
            </dd>
          </div>
        </div>
      </dl>
    </div>
  );
}
