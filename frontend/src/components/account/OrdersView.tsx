"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";

import type { Order } from "@/types";

import { AccountShell } from "@/components/account/AccountShell";
import { EmptyState } from "@/components/common/States";
import { ProductImage } from "@/components/common/ProductImage";
import { OrderStatusBadge } from "@/components/account/OrderStatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";
import { useSession } from "@/hooks/useSession";
import { getOrders } from "@/services/orderService";
import { formatDate, formatPrice } from "@/lib/utils/format";

/** Order history, newest first. */
export function OrdersView() {
  const { isSignedIn } = useSession();
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isSignedIn) return;
    let active = true;

    getOrders()
      .then((result) => {
        if (active) setOrders(result);
      })
      .catch(() => {
        if (active) setOrders([]);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isSignedIn]);

  return (
    <AccountShell
      title="Your orders"
      description="Everything you have ordered, newest first."
      breadcrumb={[{ label: "Orders" }]}
    >
      {isLoading ? (
        <div className="flex flex-col gap-4">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-40 w-full" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="When you place an order it will appear here with its delivery status. Sample orders are stored in this browser only."
          action={{ label: "Start shopping", href: "/shop" }}
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {orders.map((order) => (
            <li key={order.id}>
              <Link
                href={`/account/order?number=${order.orderNumber}`}
                className="group block rounded-card border border-ink-200 bg-shell p-4 transition-colors hover:border-ink sm:p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-display text-base text-ink">{order.orderNumber}</p>
                    <p className="mt-1 text-xs text-ink-500">
                      Placed {formatDate(order.placedAt)} &middot;{" "}
                      {order.lines.length} {order.lines.length === 1 ? "item" : "items"} &middot;{" "}
                      {formatPrice(order.totals.total)}
                    </p>
                  </div>

                  <OrderStatusBadge status={order.status} />
                </div>

                {/* A strip of thumbnails reads faster than a list of names. */}
                <div className="mt-4 flex items-center gap-2">
                  {order.lines.slice(0, 5).map((line, index) => (
                    <ProductImage
                      key={`${line.productId}-${index}`}
                      src={line.image}
                      alt=""
                      sizes="56px"
                      wrapperClassName="h-16 w-14 shrink-0 rounded-card"
                    />
                  ))}

                  {order.lines.length > 5 ? (
                    <span className="text-xs text-ink-400 tabular-nums">
                      +{order.lines.length - 5} more
                    </span>
                  ) : null}
                </div>

                <p className="mt-4 flex items-center justify-between gap-3 border-t border-ink-100 pt-3.5 text-xs">
                  <span className="text-ink-500">
                    {order.status === "delivered"
                      ? "Delivered"
                      : `Arriving ${order.expectedDelivery}`}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-copper-700">
                    View details
                    <ArrowRight
                      className="h-3.5 w-3.5 transition-transform duration-200 ease-brand group-hover:translate-x-0.5"
                      strokeWidth={1.5}
                      aria-hidden="true"
                    />
                  </span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AccountShell>
  );
}
