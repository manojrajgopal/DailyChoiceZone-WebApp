"use client";

import Link from "next/link";
import { Heart, Trash2 } from "lucide-react";

import type { ResolvedCartLine } from "@/types";

import { ProductImage } from "@/components/common/ProductImage";
import { QuantityStepper } from "@/components/common/VariantPickers";
import { Badge } from "@/components/ui/Badge";
import { Price } from "@/components/ui/Price";
import { useWishlistItem } from "@/hooks/useWishlist";
import { formatPrice, humanize } from "@/lib/utils/format";

/**
 * One line in the bag.
 *
 * The quantity ceiling is the product's live stock, so a line cannot be raised
 * above what is actually available — enforced here as well as in the store,
 * because this is where the shopper sees the limit.
 */
export function CartLineRow({
  line,
  onQuantityChange,
  onRemove,
}: {
  line: ResolvedCartLine;
  onQuantityChange: (lineId: string, quantity: number, max?: number) => void;
  onRemove: (lineId: string, productName: string) => void;
}) {
  const { product } = line;
  const { isWishlisted, toggle } = useWishlistItem(product.id);
  const outOfStock = product.stock <= 0;

  return (
    <li className="flex gap-4 py-5">
      <Link
        href={`/product/${product.slug}`}
        className="shrink-0"
        aria-label={product.name}
        tabIndex={-1}
      >
        <ProductImage
          src={product.images[0]}
          alt=""
          sizes="112px"
          wrapperClassName="h-32 w-24 rounded-card sm:h-36 sm:w-28"
        />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="label-wide text-ink-400">{humanize(product.subcategory)}</p>
            <h3 className="mt-1 text-[0.9375rem] leading-snug text-ink">
              <Link href={`/product/${product.slug}`} className="transition-colors hover:text-copper-700">
                {product.name}
              </Link>
            </h3>
            <p className="mt-0.5 text-xs text-ink-500">{product.brand}</p>

            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-500">
              {line.size ? <span>Size: {line.size}</span> : null}
              {line.color ? <span>Colour: {line.color}</span> : null}
            </p>

            {outOfStock ? (
              <Badge tone="soldout" className="mt-2">
                Out of stock — remove to check out
              </Badge>
            ) : product.stock <= 5 ? (
              <Badge tone="sale" className="mt-2">
                Only {product.stock} left
              </Badge>
            ) : null}
          </div>

          <div className="shrink-0 text-right">
            <Price
              price={line.lineTotal}
              originalPrice={
                line.lineOriginalTotal > line.lineTotal ? line.lineOriginalTotal : undefined
              }
              showDiscount={false}
            />
            {line.quantity > 1 ? (
              <p className="mt-1 text-xs text-ink-400 tabular-nums">
                {formatPrice(product.price)} each
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-4">
          <QuantityStepper
            value={line.quantity}
            onChange={(quantity) => onQuantityChange(line.lineId, quantity, product.stock)}
            max={Math.max(1, product.stock)}
            size="sm"
          />

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => toggle(product.name)}
              aria-pressed={isWishlisted}
              className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-xs text-ink-500 transition-colors hover:bg-cream-deep hover:text-ink"
            >
              <Heart
                className={isWishlisted ? "h-3.5 w-3.5 fill-clay-500 text-clay-500" : "h-3.5 w-3.5"}
                strokeWidth={1.5}
                aria-hidden="true"
              />
              {isWishlisted ? "Saved" : "Save"}
            </button>

            <button
              type="button"
              onClick={() => onRemove(line.lineId, product.name)}
              className="inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-xs text-ink-500 transition-colors hover:bg-danger-bg hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              Remove
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}
