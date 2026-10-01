"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BellRing, Check, TrendingDown } from "lucide-react";

import type { Product } from "@/types";

import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Dialog";
import { Input, Radio } from "@/components/ui/Field";
import { useCustomerStatus } from "@/hooks/useSession";
import { formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import {
  getProductAlerts,
  stopAlert,
  watchPrice,
  watchStock,
  type PriceAlert,
  type StockAlert,
} from "@/services/engagementService";
import { toast } from "@/store/toastStore";

/**
 * "Tell me when it's back" and "tell me when it's cheaper", for the product
 * page. Both need an account — the alert goes to the email on it — so a
 * signed-out shopper is sent to sign in and brought back here.
 */
function useProductAlerts(productId: string) {
  const { isSignedIn, isPending } = useCustomerStatus();
  const [stock, setStock] = useState<StockAlert[]>([]);
  const [price, setPrice] = useState<PriceAlert | null>(null);

  const reload = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const data = await getProductAlerts(productId);
      setStock(data.stock);
      setPrice(data.price);
    } catch {
      /* the buttons still work; they just don't know the current state */
    }
  }, [isSignedIn, productId]);

  useEffect(() => {
    if (!isPending) void reload();
  }, [isPending, reload]);

  return { isSignedIn, isPending, stock, price, setStock, setPrice, reload };
}

function useSignInFirst() {
  const router = useRouter();
  const pathname = usePathname();
  return () => router.push(`/account?next=${encodeURIComponent(pathname || "/")}`);
}

const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

/** The primary action on a sold-out product. */
export function StockAlertButton({ product, size, color }: { product: Product; size: string | null; color: string | null }) {
  const { isSignedIn, stock, setStock } = useProductAlerts(product.id);
  const signIn = useSignInFirst();
  const [busy, setBusy] = useState(false);
  // An alert for this variant, or for the product without a variant.
  const mine = stock.find((alert) => (alert.size || null) === (size || null) && (alert.color || null) === (color || null))
    ?? stock.find((alert) => !alert.size && !alert.color);

  const subscribe = async () => {
    if (!isSignedIn) return signIn();
    setBusy(true);
    try {
      const alert = await watchStock(product.id, size, color);
      setStock((current) => [...current.filter((a) => a.id !== alert.id), alert]);
      if (alert.alreadySubscribed) toast.info("You're already on the list — we'll email you when it's back.");
      else toast.success("We'll email you as soon as it's back in stock.");
    } catch (error) {
      toast.error(message(error, "We couldn't set up the alert. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const unsubscribe = async () => {
    if (!mine) return;
    setBusy(true);
    try {
      await stopAlert("stock", mine.id);
      setStock((current) => current.filter((a) => a.id !== mine.id));
      toast.info("Alert removed.");
    } catch (error) {
      toast.error(message(error, "We couldn't remove the alert."));
    } finally {
      setBusy(false);
    }
  };

  if (mine) {
    const variant = [mine.size, mine.color].filter(Boolean).join(" · ");
    return (
      <div className="flex w-full flex-col gap-2 rounded-card border border-sage-200 bg-sage-50 p-4 sm:flex-1" role="status">
        <p className="flex items-center gap-2 text-sm font-medium text-ink">
          <Check className="h-4 w-4 text-sage-600" strokeWidth={1.75} aria-hidden="true" />
          We&rsquo;ll email you when it&rsquo;s back{variant ? ` (${variant})` : ""}.
        </p>
        <button type="button" onClick={() => void unsubscribe()} disabled={busy}
          className="self-start text-xs text-ink-500 underline underline-offset-2 hover:text-ink disabled:opacity-50">
          Stop this alert
        </button>
      </div>
    );
  }

  return (
    <Button size="lg" onClick={() => void subscribe()} disabled={busy} className="w-full sm:w-auto sm:flex-1">
      <BellRing className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
      {busy ? "Saving…" : "Notify me when available"}
    </Button>
  );
}

/** "Tell me if the price drops" — any drop, or a price the shopper names. */
export function PriceAlertLink({ product }: { product: Product }) {
  const { isSignedIn, price, setPrice } = useProductAlerts(product.id);
  const signIn = useSignInFirst();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"any" | "target">("any");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openDialog = () => {
    if (!isSignedIn) return signIn();
    setMode(price?.mode ?? "any");
    setTarget(price?.targetPrice ? String(price.targetPrice) : String(Math.floor(product.price * 0.9)));
    setError(null);
    setOpen(true);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = Number(target);
    if (mode === "target" && (!value || value <= 0 || value >= product.price)) {
      setError(`Enter a price below today's ${formatPrice(product.price)}.`);
      return;
    }
    setBusy(true);
    try {
      const alert = await watchPrice(product.id, mode, mode === "target" ? value : undefined);
      setPrice(alert);
      setOpen(false);
      toast.success(alert.alreadySubscribed ? "Your price alert is updated." : "We'll email you when the price drops.");
    } catch (failure) {
      setError(message(failure, "We couldn't set up the alert. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!price) return;
    setBusy(true);
    try {
      await stopAlert("price", price.id);
      setPrice(null);
      setOpen(false);
      toast.info("Price alert removed.");
    } catch (failure) {
      toast.error(message(failure, "We couldn't remove the alert."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" onClick={openDialog}
        className="inline-flex items-center gap-2 text-sm text-ink-600 underline-offset-4 transition-colors hover:text-ink hover:underline">
        <TrendingDown className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
        {price
          ? price.mode === "target" && price.targetPrice
            ? `Price alert at ${formatPrice(price.targetPrice)}`
            : "Price drop alert on"
          : "Tell me if the price drops"}
      </button>

      <Modal open={open} onOpenChange={setOpen} title="Price drop alert" className="max-w-md"
        description={`Today's price is ${formatPrice(product.price)}. We'll email you once — then you can set another.`}>
        <form onSubmit={save} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2.5">
            <legend className="sr-only">When to tell you</legend>
            <Radio name="price-mode" value="any" checked={mode === "any"} onChange={() => setMode("any")}
              label="Any drop in price" />
            <Radio name="price-mode" value="target" checked={mode === "target"} onChange={() => setMode("target")}
              label="When it reaches a price I choose" />
          </fieldset>
          {mode === "target" ? (
            <Input label="Your price (₹)" type="number" inputMode="decimal" min={1} step="1" value={target}
              onChange={(event) => setTarget(event.target.value)} error={error ?? undefined} required />
          ) : error ? (
            <p role="alert" className="text-xs text-danger">{error}</p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {price ? (
              <button type="button" onClick={() => void remove()} disabled={busy}
                className="text-sm text-ink-500 underline underline-offset-2 hover:text-ink disabled:opacity-50">
                Remove alert
              </button>
            ) : <span />}
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : price ? "Update alert" : "Set alert"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
