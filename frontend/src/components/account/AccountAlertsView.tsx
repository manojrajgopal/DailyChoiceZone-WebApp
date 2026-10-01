"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BellRing, TrendingDown } from "lucide-react";

import { AccountShell } from "@/components/account/AccountShell";
import { ProductImage } from "@/components/common/ProductImage";
import { EmptyState, ErrorState } from "@/components/common/States";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { useConfirmedCustomer } from "@/hooks/useSession";
import { cn } from "@/lib/utils/cn";
import { formatDate, formatPrice } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { getMyAlerts, stopAlert, type PriceAlert, type StockAlert } from "@/services/engagementService";
import { toast } from "@/store/toastStore";

const STATUS: Record<string, { label: string; tone: string }> = {
  active: { label: "Watching", tone: "bg-copper-50 text-copper-800 ring-copper-200" },
  notified: { label: "Emailed", tone: "bg-sage-50 text-sage-600 ring-sage-200" },
  unsubscribed: { label: "Stopped", tone: "bg-cream-deep text-ink-500 ring-ink-200" },
};

/**
 * Stock and price alerts, in the account. Active ones can be stopped; past
 * ones are kept for reference, newest first.
 */
export function AccountAlertsView() {
  const signedIn = useConfirmedCustomer();
  const [data, setData] = useState<{ stock: StockAlert[]; price: PriceAlert[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    () =>
      getMyAlerts().then(
        (value) => {
          setData(value);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [],
  );

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  const stop = async (kind: "stock" | "price", id: number) => {
    setBusy(`${kind}-${id}`);
    try {
      await stopAlert(kind, id);
      toast.info("Alert stopped.");
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "We couldn't stop the alert.");
    } finally {
      setBusy(null);
    }
  };

  const empty = data && data.stock.length === 0 && data.price.length === 0;

  return (
    <AccountShell title="Stock & price alerts" description="Products you asked us to watch for you.">
      {failed ? (
        <ErrorState onRetry={() => void load()} />
      ) : !data ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : empty ? (
        <EmptyState
          title="No alerts yet"
          description="On a sold-out product, choose “Notify me when available”. On any product, choose “Tell me if the price drops”."
          action={{ label: "Browse products", href: "/shop" }}
        />
      ) : (
        <div className="flex flex-col gap-10">
          <AlertList
            title="Back in stock"
            icon={<BellRing className="h-4 w-4 text-copper-600" strokeWidth={1.5} aria-hidden="true" />}
            items={data.stock.map((alert) => ({
              key: `stock-${alert.id}`,
              alert,
              detail: [alert.size, alert.color].filter(Boolean).join(" · ") || "Any size or colour",
              note: alert.notifiedAt ? `Emailed ${formatDate(alert.notifiedAt)}` : `Since ${formatDate(alert.createdAt)}`,
              onStop: () => void stop("stock", alert.id),
            }))}
            busy={busy}
          />
          <AlertList
            title="Price drops"
            icon={<TrendingDown className="h-4 w-4 text-copper-600" strokeWidth={1.5} aria-hidden="true" />}
            items={data.price.map((alert) => ({
              key: `price-${alert.id}`,
              alert,
              detail:
                alert.mode === "target" && alert.targetPrice
                  ? `When it reaches ${formatPrice(alert.targetPrice)}`
                  : `Any drop below ${formatPrice(alert.baselinePrice)}`,
              note: alert.notifiedAt
                ? `Emailed ${formatDate(alert.notifiedAt)}${alert.notifiedPrice ? ` at ${formatPrice(alert.notifiedPrice)}` : ""}`
                : `Since ${formatDate(alert.createdAt)}`,
              onStop: () => void stop("price", alert.id),
            }))}
            busy={busy}
          />
        </div>
      )}
    </AccountShell>
  );
}

function AlertList({
  title,
  icon,
  items,
  busy,
}: {
  title: string;
  icon: React.ReactNode;
  items: { key: string; alert: StockAlert | PriceAlert; detail: string; note: string; onStop: () => void }[];
  busy: string | null;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="flex items-center gap-2 font-display text-lg text-ink">{icon}{title}</h2>
      <ul className="mt-4 flex flex-col gap-3">
        {items.map(({ key, alert, detail, note, onStop }) => {
          const status = STATUS[alert.status] ?? STATUS.active!;
          const product = alert.product;
          return (
            <li key={key} className="flex gap-4 rounded-card border border-ink-200 bg-shell p-3 sm:p-4">
              <div className="w-16 shrink-0 sm:w-20">
                <ProductImage src={product?.image} alt="" wrapperClassName="aspect-[3/4] w-full" sizes="80px" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  {product ? (
                    <Link href={`/product/${product.id}`} className="min-w-0 text-sm font-medium text-ink hover:text-copper-700">
                      {product.name}
                    </Link>
                  ) : (
                    <span className="text-sm text-ink-500">No longer available</span>
                  )}
                  <span className={cn("rounded-pill px-2 py-0.5 text-[0.6875rem] font-medium ring-1 ring-inset", status.tone)}>
                    {status.label}
                  </span>
                </div>
                <p className="text-xs text-ink-500">{detail}</p>
                {product ? (
                  <p className="text-xs text-ink-500">
                    Now {formatPrice(product.price)} · {product.available ? "In stock" : product.listed ? "Sold out" : "Not available"}
                  </p>
                ) : null}
                <p className="text-xs text-ink-400">{note}</p>
                {alert.status === "active" ? (
                  <Button variant="ghost" size="sm" className="mt-1 self-start" disabled={busy === key} onClick={onStop}>
                    {busy === key ? "Stopping…" : "Stop alert"}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
