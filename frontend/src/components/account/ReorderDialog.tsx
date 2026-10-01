"use client";

import { useEffect, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";

import { ProductImage } from "@/components/common/ProductImage";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { announceItemCount } from "@/hooks/useCart";
import { formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { fetchCartCount } from "@/services/cartService";
import { type Reorderable, type ReorderResult, getReorderable, reorder } from "@/services/messagingService";
import { toast } from "@/store/toastStore";

/**
 * Reorder: what from a past order can go back in the bag, at today's prices,
 * and what can't and why. Nothing is ordered — the shopper reviews the bag.
 * `only` limits it to one line (the "add to bag again" on a single item).
 */
export function ReorderDialog({ orderId, open, onClose, only }: { orderId: string; open: boolean; onClose: () => void; only?: string }) {
  const [data, setData] = useState<Reorderable | null>(null);
  const [failed, setFailed] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReorderResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setData(null);
    setResult(null);
    setFailed("");
    getReorderable(orderId).then((value) => {
      if (!live) return;
      setData(value);
      setChosen(new Set(value.items.filter((i) => i.quantity > 0 && (!only || i.key === only)).map((i) => i.key)));
    }).catch((error) => live && setFailed(error instanceof ApiError ? error.message : "This order couldn't be checked."));
    return () => {
      live = false;
    };
  }, [open, orderId, only]);

  const lines = data ? data.items.filter((i) => !only || i.key === only) : [];
  // Everything from the order that didn't go in: refused when submitted, or never addable.
  const notAdded = result
    ? [...result.skipped, ...lines.filter((l) => l.quantity === 0 && !result.skipped.some((s) => s.key === l.key))]
    : [];

  const submit = async () => {
    setBusy(true);
    try {
      const outcome = await reorder(orderId, [...chosen]);
      setResult(outcome);
      if (outcome.units > 0) {
        toast.success(outcome.message, { label: "View bag", href: "/cart" });
        fetchCartCount().then(announceItemCount).catch(() => undefined);
      } else {
        toast.info(outcome.message);
      }
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Those items couldn't be added.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={(value) => !value && onClose()} title={result ? "Added to your bag" : data ? `Order ${data.orderNumber} again` : "Order again"} className="max-w-xl">
      {failed ? <p className="text-sm text-danger">{failed}</p> : !data ? <p className="text-sm text-ink-500">Checking what&rsquo;s available…</p> : result ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink">{result.message}</p>
          {result.added.length ? (
            <ul className="flex flex-col gap-1.5 text-sm">{result.added.map((line) => (
              <li key={line.key} className="flex items-center gap-2 text-ink"><Check className="h-4 w-4 text-sage-600" strokeWidth={2} aria-hidden="true" />
                {line.quantity} × {line.name}{line.currentPrice !== null ? <span className="text-ink-500"> at {formatPrice(line.currentPrice)}</span> : null}</li>
            ))}</ul>
          ) : null}
          {notAdded.length ? (
            <div>
              <p className="mb-1.5 text-sm font-medium text-ink">{notAdded.length} {notAdded.length === 1 ? "item" : "items"} couldn&rsquo;t be added</p>
              <ul className="flex flex-col gap-1.5 text-sm">{notAdded.map((line) => (
                <li key={line.key} className="flex items-start gap-2 text-ink-600"><X className="mt-0.5 h-4 w-4 shrink-0 text-danger" strokeWidth={2} aria-hidden="true" />
                  <span>{line.name} — {line.reason}</span></li>
              ))}</ul>
            </div>
          ) : null}
          <p className="text-xs text-ink-400">Prices, delivery and offers are worked out again in your bag, as they are today.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Close</Button>
            {result.units > 0 ? <ButtonLink href="/cart">Review your bag</ButtonLink> : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-500">Items go into your bag at today&rsquo;s prices. Nothing is ordered until you check out.</p>
          <ul className="flex flex-col divide-y divide-ink-100">
            {lines.map((line) => {
              const addable = line.quantity > 0;
              return (
                <li key={line.key} className="flex items-center gap-3 py-3">
                  <input type="checkbox" aria-label={`Add ${line.name}`} disabled={!addable} checked={chosen.has(line.key)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(line.key); else next.delete(line.key);
                      setChosen(next);
                    }} className="h-4 w-4 accent-ink" />
                  <ProductImage src={line.image} alt="" sizes="48px" wrapperClassName="h-14 w-11 shrink-0 rounded-card" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{line.name}{line.kind === "bundle" ? <span className="text-xs text-copper-700"> · bundle</span> : null}</p>
                    <p className="text-xs text-ink-500">
                      {[line.size ? `Size ${line.size}` : null, line.color].filter(Boolean).join(" · ")}
                      {line.size || line.color ? " · " : ""}Ordered {line.orderedQuantity}
                      {addable ? ` · adding ${line.quantity}` : ""}
                    </p>
                    {line.reason ? <p className={addable ? "text-xs text-clay-600" : "text-xs text-danger"}>{line.reason}</p> : null}
                  </div>
                  <p className="shrink-0 text-right text-sm text-ink tabular-nums">
                    {line.currentPrice !== null ? formatPrice(line.currentPrice) : "—"}
                    {line.orderedUnitPrice !== undefined && line.currentPrice !== null && line.currentPrice !== line.orderedUnitPrice ? (
                      <span className="block text-xs text-ink-400">was {formatPrice(line.orderedUnitPrice)}</span>) : null}
                  </p>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button disabled={busy || chosen.size === 0} onClick={() => void submit()}>
              <RotateCcw className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              {busy ? "Adding…" : chosen.size ? `Add ${chosen.size} to bag` : "Nothing can be added"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
