"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Layers } from "lucide-react";

import { ProductImage } from "@/components/common/ProductImage";
import { EmptyState, ErrorState } from "@/components/common/States";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { announceItemCount } from "@/hooks/useCart";
import { useSession } from "@/hooks/useSession";
import { productHref } from "@/lib/products/colourImages";
import { formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { type BundleView, addBundleToCart, getBundle, getBundles } from "@/services/growthService";
import { toast } from "@/store/toastStore";

function BundleCard({ bundle }: { bundle: BundleView }) {
  return (
    <Link href={`/bundles/${bundle.slug}`} className="group block">
      <ProductImage src={bundle.image} alt="" sizes="(min-width: 1024px) 25vw, 50vw" wrapperClassName="aspect-[4/5] w-full rounded-card" />
      <p className="mt-3 label-wide inline-flex items-center gap-1.5 text-copper-700"><Layers className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" /> {bundle.components.length} pieces</p>
      <h3 className="mt-1 text-[0.9375rem] text-ink group-hover:text-copper-700">{bundle.name}</h3>
      <p className="mt-1 text-sm">
        <span className="font-medium text-ink">{formatPrice(bundle.price)}</span>
        {bundle.saving > 0 ? <span className="ml-2 text-ink-400 line-through">{formatPrice(bundle.regularPrice)}</span> : null}
        {bundle.saving > 0 ? <span className="ml-2 text-clay-600">Save {bundle.savingPercent}%</span> : null}
      </p>
      {!bundle.purchasable ? <p className="mt-1 text-xs text-ink-500">{bundle.reason}</p> : null}
    </Link>
  );
}

/** Every bundle on sale. */
export function BundlesView() {
  const [bundles, setBundles] = useState<BundleView[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    getBundles().then(setBundles).catch(() => setFailed(true));
  }, []);
  return (
    <div className="page-shell py-8 sm:py-10">
      <h1 className="font-display text-[1.75rem] leading-tight text-ink sm:text-3xl">Bundles & combos</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">Pieces that go together, for less than buying them one by one.</p>
      {failed ? <ErrorState title="Bundles didn't load" description="Please try again." className="mt-8" /> : !bundles ? (
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-72 w-full" />)}</div>
      ) : bundles.length === 0 ? (
        <EmptyState title="No bundles right now" description="Check back soon." action={{ label: "Shop everything", href: "/shop" }} className="mt-6" />
      ) : (
        <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 lg:grid-cols-4">
          {bundles.map((bundle) => <BundleCard key={bundle.id} bundle={bundle} />)}
        </div>
      )}
    </div>
  );
}

/** "Buy it in a bundle" on a product page. Renders nothing when there are none. */
export function ProductBundles({ productId }: { productId: string }) {
  const [bundles, setBundles] = useState<BundleView[]>([]);
  useEffect(() => {
    getBundles(productId).then(setBundles).catch(() => setBundles([]));
  }, [productId]);
  if (!bundles.length) return null;
  return (
    <section aria-labelledby="bundles-heading" className="page-shell mt-16">
      <h2 id="bundles-heading" className="mb-6 font-display text-2xl text-ink">Buy it in a bundle</h2>
      <div className="grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 lg:grid-cols-4">
        {bundles.slice(0, 4).map((bundle) => <BundleCard key={bundle.id} bundle={bundle} />)}
      </div>
    </section>
  );
}

/** One bundle: what's in it, a size and colour for each piece, and add to bag. */
export function BundleDetailView({ slug }: { slug: string }) {
  const { isSignedIn } = useSession();
  const [bundle, setBundle] = useState<BundleView | null>(null);
  const [failed, setFailed] = useState(false);
  const [choices, setChoices] = useState<Record<string, { size: string; color: string }>>({});
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getBundle(slug).then((b) => {
      setBundle(b);
      setChoices(Object.fromEntries(b.components.map((c) => [c.productId, { size: "", color: c.product.colors[0]?.name ?? "" }])));
    }).catch(() => setFailed(true));
  }, [slug]);

  if (failed) return <div className="page-shell py-10"><EmptyState title="This bundle isn't available" description="It may have ended or sold out." action={{ label: "See all bundles", href: "/bundles" }} /></div>;
  if (!bundle) return <div className="page-shell py-10"><Skeleton className="h-96 w-full" /></div>;

  const missingSize = bundle.components.some((c) => c.product.sizes.length > 0 && !choices[c.productId]?.size);

  const add = async () => {
    setBusy(true);
    try {
      const cart = await addBundleToCart(bundle.id, quantity, bundle.components.map((c) => ({
        productId: c.productId, size: choices[c.productId]?.size || null, color: choices[c.productId]?.color || null,
      })));
      announceItemCount(cart.breakdown.itemCount);
      toast.success(`${bundle.name} added to bag`, { label: "View bag", href: "/cart" });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not add the bundle.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-shell py-8 sm:py-10">
      <nav className="text-xs text-ink-500"><Link href="/bundles" className="hover:text-ink">Bundles</Link> / {bundle.name}</nav>
      <div className="mt-6 grid gap-10 lg:grid-cols-[1fr_26rem]">
        <div className="grid grid-cols-2 gap-3">
          {bundle.components.map((c) => (
            <Link key={c.productId} href={productHref(c.product)} className="block">
              <ProductImage src={c.product.images[0]} alt={c.product.name} sizes="(min-width: 1024px) 30vw, 50vw" wrapperClassName="aspect-[4/5] w-full rounded-card" />
              <p className="mt-2 text-sm text-ink">{c.quantity > 1 ? `${c.quantity} × ` : ""}{c.product.name}</p>
              <p className="text-xs text-ink-500">{formatPrice(c.regularPrice)} on its own</p>
            </Link>
          ))}
        </div>
        <div>
          <p className="label-wide inline-flex items-center gap-1.5 text-copper-700"><Layers className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" /> Bundle</p>
          <h1 className="mt-2 font-display text-3xl leading-tight text-ink">{bundle.name}</h1>
          <p className="mt-4 text-2xl text-ink">
            {formatPrice(bundle.price)}
            {bundle.saving > 0 ? <span className="ml-3 text-base text-ink-400 line-through">{formatPrice(bundle.regularPrice)}</span> : null}
          </p>
          {bundle.saving > 0 ? <p className="mt-1 text-sm text-clay-600">You save {formatPrice(bundle.saving)} ({bundle.savingPercent}%)</p> : null}
          <p className="mt-1 text-xs text-ink-400">Inclusive of all taxes · each piece is taxed at its own rate</p>
          {bundle.description ? <p className="mt-5 whitespace-pre-line text-sm leading-relaxed text-ink-600">{bundle.description}</p> : null}

          <div className="mt-6 flex flex-col gap-4 border-y border-ink-200 py-5">
            {bundle.components.map((c) => (
              <div key={c.productId}>
                <p className="text-sm font-medium text-ink">{c.quantity > 1 ? `${c.quantity} × ` : ""}{c.product.name}</p>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {c.product.sizes.length ? (
                    <Select label="Size" value={choices[c.productId]?.size ?? ""} required
                      onChange={(e) => setChoices({ ...choices, [c.productId]: { ...choices[c.productId]!, size: e.target.value } })}
                      options={[{ value: "", label: "Choose" }, ...c.product.sizes.map((s) => ({ value: s, label: s }))]} />
                  ) : null}
                  {c.product.colors.length > 1 ? (
                    <Select label="Colour" value={choices[c.productId]?.color ?? ""}
                      onChange={(e) => setChoices({ ...choices, [c.productId]: { ...choices[c.productId]!, color: e.target.value } })}
                      options={c.product.colors.map((col) => ({ value: col.name, label: col.name }))} />
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {!bundle.purchasable ? <p className="mt-5 text-sm text-danger">{bundle.reason}</p> : (
            <div className="mt-5 flex flex-col gap-3">
              <Select label="How many" value={String(quantity)} onChange={(e) => setQuantity(Number(e.target.value))}
                options={Array.from({ length: Math.max(1, Math.min(bundle.maxPerOrder, bundle.available)) }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))} />
              {isSignedIn ? (
                <Button size="lg" fullWidth disabled={busy || missingSize} onClick={() => void add()}>
                  {busy ? "Adding…" : missingSize ? "Choose a size for each piece" : "Add bundle to bag"}
                </Button>
              ) : (
                <ButtonLink size="lg" fullWidth href={`/account?next=${encodeURIComponent(`/bundles/${bundle.slug}`)}`}>Sign in to buy this bundle</ButtonLink>
              )}
              {bundle.available <= 5 ? <p className="text-xs text-ink-500">Only {bundle.available} left.</p> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
