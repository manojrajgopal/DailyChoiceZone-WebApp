"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Check, GitCompareArrows, X } from "lucide-react";

import type { Product } from "@/types";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { COMPARE_LIMIT, useCompareList } from "@/hooks/useCompare";
import { cn } from "@/lib/utils/cn";
import { getProductsByIds } from "@/services/productService";

/**
 * "Compare" on a product card or the product page.
 *
 * At the limit it doesn't fail silently: it asks which product to swap out.
 */
export function CompareButton({
  product,
  variant = "icon",
  className,
}: {
  product: Pick<Product, "id" | "name">;
  variant?: "icon" | "text";
  className?: string;
}) {
  const { has, add, remove, productIds } = useCompareList();
  const [choosing, setChoosing] = useState(false);
  const active = has(product.id);

  const toggle = async () => {
    if (active) {
      await remove(product.id);
      return;
    }
    const outcome = await add(product);
    if (outcome === "full") setChoosing(true);
  };

  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={() => void toggle()}
          aria-pressed={active}
          aria-label={active ? `Remove ${product.name} from comparison` : `Compare ${product.name}`}
          title={active ? "In your comparison" : "Compare"}
          className={cn(
            "inline-flex h-9 w-9 items-center justify-center rounded-pill bg-shell/90 shadow-subtle backdrop-blur-sm transition-colors hover:bg-shell",
            active ? "text-copper-700" : "text-ink",
            className,
          )}
        >
          {active ? <Check className="h-4 w-4" strokeWidth={1.75} /> : <GitCompareArrows className="h-4 w-4" strokeWidth={1.5} />}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void toggle()}
          aria-pressed={active}
          className={cn(
            "inline-flex items-center gap-2 text-sm text-ink-600 underline-offset-4 transition-colors hover:text-ink hover:underline",
            active && "text-copper-700",
            className,
          )}
        >
          {active ? <Check className="h-4 w-4" strokeWidth={1.75} /> : <GitCompareArrows className="h-4 w-4" strokeWidth={1.5} />}
          {active ? "In your comparison" : "Add to compare"}
        </button>
      )}

      <ReplaceDialog
        open={choosing}
        onOpenChange={setChoosing}
        incoming={product}
        productIds={productIds}
        onReplace={async (id) => {
          const outcome = await add(product, id);
          if (outcome === "added") setChoosing(false);
        }}
      />
    </>
  );
}

function ReplaceDialog({
  open,
  onOpenChange,
  incoming,
  productIds,
  onReplace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  incoming: Pick<Product, "id" | "name">;
  productIds: string[];
  onReplace: (productId: string) => Promise<void>;
}) {
  const [items, setItems] = useState<Product[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const key = productIds.join(",");

  useEffect(() => {
    if (!open || !key) return;
    let live = true;
    getProductsByIds(key.split(","))
      .then((result) => live && setItems(result))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, [open, key]);

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Your comparison is full" className="max-w-md">
      <p className="text-sm leading-relaxed text-ink-600">
        You can compare up to {COMPARE_LIMIT} products. Choose one to swap for <strong className="text-ink">{incoming.name}</strong>.
      </p>
      <ul className="mt-4 flex flex-col divide-y divide-ink-100 rounded-card border border-ink-200">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
            <span className="min-w-0 truncate text-sm text-ink">{item.name}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(item.id);
                await onReplace(item.id);
                setBusy(null);
              }}
            >
              {busy === item.id ? "Swapping…" : "Replace"}
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-between gap-3">
        <Link href="/compare" className="text-sm text-ink-600 underline underline-offset-4 hover:text-ink">
          Open comparison
        </Link>
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          Keep my list
        </Button>
      </div>
    </Modal>
  );
}

/** A slim bar at the foot of the page while products are waiting to be compared. */
export function CompareTray() {
  const pathname = usePathname();
  const { count, clear } = useCompareList();
  if (count === 0 || pathname?.startsWith("/compare") || pathname?.startsWith("/checkout")) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div
        role="region"
        aria-label="Product comparison"
        className="pointer-events-auto flex items-center gap-3 rounded-pill border border-ink-200 bg-shell/95 py-2 pl-4 pr-2 shadow-overlay backdrop-blur"
      >
        <GitCompareArrows className="h-4 w-4 shrink-0 text-copper-700" strokeWidth={1.5} aria-hidden="true" />
        <span className="text-sm text-ink">
          {count} of {COMPARE_LIMIT} to compare
        </span>
        <Link
          href="/compare"
          className="inline-flex items-center gap-1.5 rounded-pill bg-ink px-3.5 py-1.5 text-xs font-medium tracking-wide text-cream transition-colors hover:bg-ink-800"
        >
          Compare
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        </Link>
        <button
          type="button"
          onClick={() => void clear()}
          aria-label="Clear the comparison"
          className="inline-flex h-7 w-7 items-center justify-center rounded-pill text-ink-500 hover:bg-cream-deep hover:text-ink"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
