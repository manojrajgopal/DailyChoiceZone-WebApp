"use client";

import { ArrowRight } from "lucide-react";

import { AccountShell } from "@/components/account/AccountShell";
import { EmptyState } from "@/components/common/States";
import { ProductCard } from "@/components/products/ProductCard";
import { ButtonLink } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useWishlist } from "@/hooks/useWishlist";

/** How many saved products the account page previews. */
const PREVIEW = 4;

/**
 * The wishlist, inside the account area.
 *
 * A preview rather than the whole list: the account area is a summary of the
 * customer's things, and the full wishlist — with move-to-bag and remove —
 * has its own page. The link to it appears only when there is more to see.
 */
export function AccountWishlistView() {
  const { products, count, isLoading, isEmpty } = useWishlist();
  const shown = products.slice(0, PREVIEW);
  const more = count > shown.length;

  return (
    <AccountShell
      title="Wishlist"
      description="The pieces you love and may come back for."
      breadcrumb={[{ label: "Wishlist" }]}
    >
      {isLoading && shown.length === 0 ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: PREVIEW }, (_, index) => (
            <Skeleton key={index} className="aspect-[3/4] w-full" />
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyState
          title="Nothing saved yet"
          description="Tap the heart on any product to keep it here for later."
          action={{ label: "Discover products", href: "/shop" }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm text-ink-500">
              {more
                ? `Showing ${shown.length} of ${count} saved items`
                : `${count} saved ${count === 1 ? "item" : "items"}`}
            </p>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-8 lg:grid-cols-4">
            {shown.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                sizes="(min-width: 1024px) 18vw, 45vw"
              />
            ))}
          </div>

          <div className="mt-8 flex justify-center border-t border-ink-100 pt-6">
            <ButtonLink href="/wishlist" variant={more ? "primary" : "outline"} className="gap-2">
              {more ? `View complete wishlist · ${count} items` : "Manage wishlist"}
              <ArrowRight className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
            </ButtonLink>
          </div>
        </>
      )}
    </AccountShell>
  );
}
