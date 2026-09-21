"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Heart } from "lucide-react";

import type { Product } from "@/types";

import { ProductImage } from "@/components/common/ProductImage";
import { ColorPicker, QuantityStepper, SizePicker } from "@/components/common/VariantPickers";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Price } from "@/components/ui/Price";
import { Rating } from "@/components/ui/Rating";
import { useCart } from "@/hooks/useCart";
import { useWishlistItem } from "@/hooks/useWishlist";
import { cn } from "@/lib/utils/cn";
import { humanize } from "@/lib/utils/format";
import { toast } from "@/store/toastStore";

/**
 * Quick view.
 *
 * Enough to decide and buy without leaving the grid: gallery, price, rating,
 * variants and add-to-bag. Anything more belongs on the product page, and
 * "View full details" is one click away.
 */
export function QuickViewDialog({
  product,
  open,
  onOpenChange,
}: {
  product: Product;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={product.name} hideTitle>
      {/*
        The body is its own component so that Radix unmounting the dialog on
        close genuinely resets it. Variant choices therefore start fresh on
        every open, with no reset effect to remember to keep in step.
      */}
      <QuickViewBody product={product} onClose={() => onOpenChange(false)} />
    </Modal>
  );
}

function QuickViewBody({ product, onClose }: { product: Product; onClose: () => void }) {
  const { add } = useCart();
  const { isWishlisted, toggle } = useWishlistItem(product.id);

  const [activeImage, setActiveImage] = useState(0);
  const [size, setSize] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(product.colors[0]?.name ?? null);
  const [quantity, setQuantity] = useState(1);
  const [sizeError, setSizeError] = useState(false);

  const needsSize = product.sizes.length > 0;
  const outOfStock = product.stock <= 0;

  const onAdd = () => {
    if (needsSize && !size) {
      setSizeError(true);
      toast.error("Please select a size first");
      return;
    }
    add(product, { size, color, quantity });
    onClose();
  };

  return (
    <div className="grid gap-6 sm:grid-cols-2">
        {/* ------------------------------------------------------- gallery */}
        <div className="flex flex-col gap-3">
          <ProductImage
            src={product.images[activeImage]}
            alt={product.name}
            sizes="(min-width: 640px) 45vw, 90vw"
            wrapperClassName="aspect-[3/4] w-full rounded-card"
          />

          {product.images.length > 1 ? (
            <div className="flex gap-2" role="tablist" aria-label="Product images">
              {product.images.slice(0, 4).map((image, index) => (
                <button
                  key={image}
                  type="button"
                  role="tab"
                  aria-selected={index === activeImage}
                  aria-label={`View image ${index + 1}`}
                  onClick={() => setActiveImage(index)}
                  className={cn(
                    "relative h-16 w-14 shrink-0 overflow-hidden rounded-card border transition-colors",
                    index === activeImage
                      ? "border-ink"
                      : "border-transparent hover:border-ink-300",
                  )}
                >
                  <ProductImage
                    src={image}
                    alt=""
                    sizes="56px"
                    wrapperClassName="absolute inset-0"
                  />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* -------------------------------------------------------- detail */}
        <div className="flex flex-col">
          <p className="label-wide text-ink-400">
            {humanize(product.category)} &middot; {humanize(product.subcategory)}
          </p>

          <h2 className="mt-2 font-display text-xl leading-snug text-ink">{product.name}</h2>
          <p className="mt-1 text-sm text-ink-500">{product.brand}</p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Rating value={product.rating} reviewCount={product.reviewCount} />
            {outOfStock ? (
              <Badge tone="soldout">Sold out</Badge>
            ) : product.stock <= 5 ? (
              <Badge tone="sale">Only {product.stock} left</Badge>
            ) : (
              <Badge tone="stock">In stock</Badge>
            )}
          </div>

          <Price
            price={product.price}
            originalPrice={product.originalPrice}
            discount={product.discount}
            size="lg"
            className="mt-4"
          />

          <p className="mt-4 line-clamp-3 text-sm leading-relaxed text-ink-500">
            {product.description}
          </p>

          {product.colors.length > 0 ? (
            <div className="mt-5">
              <p className="label-wide mb-2 text-ink-700">
                Colour{color ? <span className="ml-2 text-ink-400">{color}</span> : null}
              </p>
              <ColorPicker colors={product.colors} value={color} onChange={setColor} />
            </div>
          ) : null}

          {needsSize ? (
            <div className="mt-5">
              <p className="label-wide mb-2 text-ink-700">Size</p>
              <SizePicker
                sizes={product.sizes}
                value={size}
                onChange={(next) => {
                  setSize(next);
                  setSizeError(false);
                }}
                error={sizeError}
              />
            </div>
          ) : null}

          <div className="mt-5 flex items-center gap-3">
            <p className="label-wide text-ink-700">Qty</p>
            <QuantityStepper
              value={quantity}
              onChange={setQuantity}
              max={Math.max(1, product.stock)}
              size="sm"
            />
          </div>

          <div className="mt-6 flex gap-2">
            <Button onClick={onAdd} disabled={outOfStock} fullWidth>
              {outOfStock ? "Sold out" : "Add to bag"}
            </Button>

            <Button
              variant="outline"
              onClick={() => toggle(product.name)}
              aria-pressed={isWishlisted}
              aria-label={isWishlisted ? "Remove from wishlist" : "Save to wishlist"}
              className="w-12 shrink-0 px-0"
            >
              <Heart
                className={cn("h-4 w-4", isWishlisted && "fill-clay-500 text-clay-500")}
                strokeWidth={1.5}
              />
            </Button>
          </div>

          <Link
            href={`/product/${product.slug}`}
            onClick={onClose}
            className="group mt-4 inline-flex items-center gap-1.5 self-start border-b border-ink pb-0.5 label-wide text-ink transition-colors hover:border-copper-600 hover:text-copper-700"
          >
            View full details
            <ArrowRight
              className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
              strokeWidth={1.5}
              aria-hidden="true"
            />
          </Link>
      </div>
    </div>
  );
}
