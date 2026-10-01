"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Zap } from "lucide-react";

import { Countdown } from "@/components/growth/Countdown";
import { ProductCard } from "@/components/products/ProductCard";
import { EmptyState, ErrorState } from "@/components/common/States";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatPrice } from "@/lib/utils/format";
import { type FlashSaleView, getFlashSales } from "@/services/growthService";
import type { Product } from "@/types";

/** The flash sale note on a product page: sale name, time left, units left and the limit. */
export function FlashSaleNotice({ product }: { product: Product }) {
  const sale = product.flashSale;
  const [ended, setEnded] = useState(false);
  if (!sale) return null;
  return (
    <div className="mt-3 rounded-card border border-clay-300 bg-clay-50 p-3 text-sm text-ink-700">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-clay-700">
        <Zap className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        {sale.name}
        {ended ? <span className="font-normal text-ink-500">has ended — the price will update.</span> : (
          <span className="font-normal text-ink-600">ends in <Countdown until={sale.endsAt} className="tabular-nums font-medium" onDone={() => setEnded(true)} /></span>
        )}
      </p>
      <p className="mt-1 text-xs text-ink-500">
        Regular price {formatPrice(sale.regularPrice)}
        {sale.remaining !== null ? ` · ${sale.remaining} left at this price` : ""}
        {sale.perCustomerLimit ? ` · up to ${sale.perCustomerLimit} per customer` : ""}
        {sale.allowCoupons ? "" : " · coupons can't be used with sale items"}
      </p>
    </div>
  );
}

function useFlashSales() {
  const [data, setData] = useState<{ live: FlashSaleView[]; upcoming: FlashSaleView[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    getFlashSales().then(setData).catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { data, failed, reload: load };
}

/** The home page strip: shown only while a sale is live. */
export function FlashSaleStrip() {
  const { data, reload } = useFlashSales();
  const sale = data?.live[0];
  if (!sale) return null;
  const items = sale.items.filter((item) => !item.soldOut).slice(0, 8);
  if (!items.length) return null;
  return (
    <section aria-labelledby="flash-strip-heading" className="page-shell py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="label-wide inline-flex items-center gap-1.5 text-clay-700"><Zap className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Flash sale</p>
          <h2 id="flash-strip-heading" className="mt-1 font-display text-2xl text-ink">{sale.name}</h2>
          <p className="mt-1 text-sm text-ink-500">Ends in <Countdown until={sale.endsAt} className="font-medium tabular-nums text-ink" onDone={reload} /></p>
        </div>
        <Link href="/flash-sales" className="text-sm text-copper-700 underline underline-offset-4 hover:text-ink">See the whole sale</Link>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item) => <ProductCard key={item.id} product={item.product} />)}
      </div>
    </section>
  );
}

/** The flash sales page: what's on now, and what's coming up. */
export function FlashSalesView() {
  const { data, failed, reload } = useFlashSales();
  return (
    <div className="page-shell py-8 sm:py-10">
      <h1 className="font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">Flash sales</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">Limited-time prices while sale stock lasts. The price is confirmed at checkout.</p>
      {failed ? <ErrorState title="Flash sales didn't load" description="Please try again." className="mt-8" /> : !data ? (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72 w-full" />)}</div>
      ) : !data.live.length && !data.upcoming.length ? (
        <EmptyState title="No flash sales right now" description="Check back soon — or add favourites to your wishlist and we'll email you when one goes on sale." action={{ label: "Shop everything", href: "/shop" }} className="mt-6" />
      ) : (
        <div className="mt-8 flex flex-col gap-14">
          {data.live.map((sale) => (
            <section key={sale.id} aria-labelledby={`sale-${sale.id}`}>
              <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-ink-200 pb-4">
                <div>
                  <h2 id={`sale-${sale.id}`} className="font-display text-2xl text-ink">{sale.name}</h2>
                  {sale.description ? <p className="mt-1 text-sm text-ink-500">{sale.description}</p> : null}
                </div>
                <p className="text-sm text-ink-600">Ends in <Countdown until={sale.endsAt} className="font-medium tabular-nums text-clay-700" onDone={reload} /></p>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
                {sale.items.map((item) => (
                  <div key={item.id}>
                    <ProductCard product={item.product} />
                    <p className="mt-1 text-xs text-ink-500">
                      {item.soldOut ? "Sale stock sold out" : item.remaining !== null ? `${item.remaining} left at the sale price` : ""}
                      {item.perCustomerLimit ? `${item.soldOut || item.remaining !== null ? " · " : ""}Up to ${item.perCustomerLimit} each` : ""}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {data.upcoming.length ? (
            <section aria-labelledby="upcoming-heading">
              <h2 id="upcoming-heading" className="mb-4 font-display text-xl text-ink">Coming up</h2>
              <ul className="flex flex-col divide-y divide-ink-100 border-y border-ink-200">
                {data.upcoming.map((sale) => (
                  <li key={sale.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                    <div>
                      <p className="font-medium text-ink">{sale.name}</p>
                      <p className="text-xs text-ink-500">{sale.items.length} product{sale.items.length === 1 ? "" : "s"} · {sale.items.slice(0, 3).map((i) => i.product.name).join(", ")}</p>
                    </div>
                    <p className="text-sm text-ink-600">Starts in <Countdown until={sale.startsAt} className="font-medium tabular-nums" onDone={reload} /></p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
