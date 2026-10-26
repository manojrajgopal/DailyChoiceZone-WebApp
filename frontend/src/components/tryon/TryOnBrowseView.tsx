"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

import { EmptyState, ErrorState } from "@/components/common/States";
import { useTryOnCatalogue } from "@/components/tryon/useTryOn";
import { Badge } from "@/components/ui/Badge";
import { Pagination } from "@/components/ui/Pagination";
import { Price } from "@/components/ui/Price";
import { ProductGridSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils/cn";
import { type TryOnProductCard, listTryOnProducts } from "@/services/tryOnService";

const PAGE_SIZE = 24;

/**
 * Everything that can be tried on, by kind of item — and the kinds that are
 * coming, so nobody is promised a try-on that can't be done yet.
 */
export function TryOnBrowseView() {
  const catalogue = useTryOnCatalogue();
  const [capability, setCapability] = useState("");
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const key = `${capability}|${page}|${attempt}`;
  const [result, setResult] = useState<{ key: string; items: TryOnProductCard[] | null; totalPages: number; failed: boolean }>(
    { key: "", items: null, totalPages: 1, failed: false },
  );
  const current = result.key === key ? result : { key, items: null, totalPages: 1, failed: false };
  const { items, totalPages, failed } = current;

  useEffect(() => {
    let active = true;
    listTryOnProducts({ capability: capability || undefined, page, pageSize: PAGE_SIZE }).then(
      (value) => active && setResult({ key, items: value.items, totalPages: value.pagination.total_pages, failed: false }),
      () => active && setResult({ key, items: null, totalPages: 1, failed: true }),
    );
    return () => {
      active = false;
    };
  }, [capability, page, key]);

  const available = catalogue?.capabilities.filter((c) => c.state === "available") ?? [];
  const coming = catalogue?.capabilities.filter((c) => c.state === "coming_soon") ?? [];

  return (
    <div className="page-shell py-10">
      <p className="label-wide text-copper-700">Virtual try-on</p>
      <h1 className="mt-2 font-display text-3xl text-ink">See it on you before you buy</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-600">
        Upload a photo and see how an item looks on you. Included with selected memberships — your photos stay
        private and you can delete them whenever you like.
      </p>

      {catalogue && !catalogue.enabled ? (
        <EmptyState title="Virtual try-on isn't available right now" description="Please check back soon." />
      ) : (
        <>
          <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Kinds of item">
            {[{ key: "", name: "Everything" }, ...available].map((c) => (
              <button
                key={c.key || "all"}
                type="button"
                role="tab"
                aria-selected={capability === c.key}
                onClick={() => { setCapability(c.key); setPage(1); }}
                className={cn(
                  "rounded-pill border px-4 py-1.5 text-sm transition-colors",
                  capability === c.key ? "border-ink bg-ink text-cream" : "border-ink-200 text-ink hover:border-ink",
                )}
              >
                {c.name}
              </button>
            ))}
          </div>

          {coming.length ? (
            <p className="mt-4 flex flex-wrap items-center gap-2 text-sm text-ink-600">
              <Sparkles className="h-4 w-4 text-copper-500" aria-hidden="true" /> Coming soon:
              {coming.map((c) => <Badge key={c.key} tone="neutral">{c.name}</Badge>)}
            </p>
          ) : null}

          <div className="mt-8">
            {failed ? (
              <ErrorState onRetry={() => setAttempt((n) => n + 1)} />
            ) : !items ? (
              <ProductGridSkeleton count={8} />
            ) : items.length === 0 ? (
              <EmptyState title="Nothing to try on yet" description="Items you can try on virtually will appear here." action={{ label: "Shop everything", href: "/shop" }} />
            ) : (
              <>
                <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
                  {items.map((item) => (
                    <li key={item.id}>
                      <Link href={`/product/${item.id}`} className="group block">
                        <span className="relative block aspect-[3/4] overflow-hidden rounded-card bg-cream-deep">
                          {item.image ? (
                            // eslint-disable-next-line @next/next/no-img-element -- catalogue photos may be external links
                            <img src={item.image} alt="" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]" />
                          ) : null}
                          <span className="absolute left-2.5 top-2.5">
                            <Badge tone="neutral" className="gap-1"><Sparkles className="h-3 w-3" aria-hidden="true" /> Try on</Badge>
                          </span>
                        </span>
                        <span className="mt-3 block text-xs text-ink-500">{item.brand}</span>
                        <span className="block text-sm text-ink group-hover:text-copper-700">{item.name}</span>
                        <Price price={item.price} originalPrice={item.originalPrice} className="mt-1" />
                      </Link>
                    </li>
                  ))}
                </ul>
                {totalPages > 1 ? <Pagination className="mt-8" page={page} totalPages={totalPages} onPageChange={setPage} /> : null}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
