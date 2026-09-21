"use client";

import { ShoppingBag, Trash2 } from "lucide-react";

import { ProductImage } from "@/components/common/ProductImage";
import { EmptyState } from "@/components/common/States";
import { Badge } from "@/components/ui/Badge";
import { Breadcrumb } from "@/components/ui/Breadcrumb";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Price } from "@/components/ui/Price";
import { Rating } from "@/components/ui/Rating";
import { ProductGridSkeleton } from "@/components/ui/Skeleton";
import { useCart } from "@/hooks/useCart";
import { useWishlist } from "@/hooks/useWishlist";
import { humanize } from "@/lib/utils/format";

import Link from "next/link";

/**
 * The wishlist.
 *
 * "Move to bag" is the primary action rather than plain "add", since the
 * shopper has already decided — it adds to the bag *and* clears the item from
 * the list, which is what the label promises.
 *
 * Items needing a size cannot be moved directly: they link to the product page
 * instead, because silently choosing a size on someone's behalf is worse than
 * one extra click.
 */
export function WishlistView() {
  const { products, isLoading, isEmpty, remove } = useWishlist();
  const { add } = useCart();

  return (
    <div className="page-shell py-8 sm:py-10">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Wishlist" }]} />

      <h1 className="mt-4 font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">
        Wishlist
        {!isLoading && products.length > 0 ? (
          <span className="ml-3 align-middle text-base font-normal text-ink-400 tabular-nums">
            {products.length} {products.length === 1 ? "item" : "items"}
          </span>
        ) : null}
      </h1>

      {isLoading ? (
        <div className="mt-8">
          <ProductGridSkeleton count={4} />
        </div>
      ) : isEmpty ? (
        <EmptyState
          title="Nothing saved yet"
          description="Tap the heart on any product to keep it here for later. Saved items stay in this browser."
          action={{ label: "Find something you like", href: "/shop" }}
          className="mt-4"
        />
      ) : (
        <ul className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => {
            const outOfStock = product.stock <= 0;
            const needsSize = product.sizes.length > 0;

            return (
              <li
                key={product.id}
                className="flex gap-4 rounded-card border border-ink-200 bg-shell p-4"
              >
                <Link href={`/product/${product.slug}`} className="shrink-0" tabIndex={-1} aria-hidden="true">
                  <ProductImage
                    src={product.images[0]}
                    alt=""
                    sizes="112px"
                    wrapperClassName="h-32 w-24 rounded-card"
                  />
                </Link>

                <div className="flex min-w-0 flex-1 flex-col">
                  <p className="label-wide text-ink-400">{humanize(product.subcategory)}</p>

                  <h2 className="mt-1 text-sm leading-snug text-ink">
                    <Link
                      href={`/product/${product.slug}`}
                      className="transition-colors hover:text-copper-700"
                    >
                      {product.name}
                    </Link>
                  </h2>

                  <p className="mt-0.5 text-xs text-ink-500">{product.brand}</p>

                  <Price
                    price={product.price}
                    originalPrice={product.originalPrice}
                    discount={product.discount}
                    size="sm"
                    className="mt-1.5"
                  />

                  <Rating
                    value={product.rating}
                    reviewCount={product.reviewCount}
                    showValue={false}
                    className="mt-1"
                  />

                  {outOfStock ? <Badge tone="soldout" className="mt-2 self-start">Out of stock</Badge> : null}

                  <div className="mt-auto flex items-center gap-1.5 pt-3">
                    {outOfStock ? (
                      <Button size="sm" variant="outline" disabled className="flex-1">
                        Unavailable
                      </Button>
                    ) : needsSize ? (
                      // Picking a size on someone's behalf would be worse than
                      // sending them one click onward to choose it themselves.
                      <ButtonLink
                        href={`/product/${product.slug}`}
                        size="sm"
                        variant="outline"
                        className="flex-1"
                      >
                        Choose size
                      </ButtonLink>
                    ) : (
                      <Button
                        size="sm"
                        className="flex-1"
                        onClick={() => {
                          add(product, { color: product.colors[0]?.name ?? null });
                          remove(product);
                        }}
                      >
                        <ShoppingBag className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                        Move to bag
                      </Button>
                    )}

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => remove(product)}
                      aria-label={`Remove ${product.name} from wishlist`}
                      className="shrink-0 px-2.5"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
