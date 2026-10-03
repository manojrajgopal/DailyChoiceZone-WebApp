"use client";

import { useEffect, useState } from "react";

import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { listOrderRefunds } from "@/services/refundHistoryService";
import type { CustomerRefund } from "@/types/refunds";

const TONE: Record<CustomerRefund["status"], string> = {
  requested: "bg-ink-100 text-ink-700",
  processing: "bg-[#fdf3e1] text-[#8a5a12]",
  completed: "bg-[#e7f4e7] text-[#0a6b0a]",
};

/**
 * The order's refunds as the customer sees them: how much, for which items,
 * where the money goes and whether it has arrived. Nothing internal is sent
 * for it — no notes, references or staff. Shown only when there is a refund.
 */
export function OrderRefunds({ orderNumber }: { orderNumber: string }) {
  const [refunds, setRefunds] = useState<CustomerRefund[] | null>(null);

  useEffect(() => {
    let live = true;
    listOrderRefunds(orderNumber)
      .then((items) => live && setRefunds(items))
      // Quietly absent: the order page has everything else the customer needs.
      .catch(() => live && setRefunds([]));
    return () => {
      live = false;
    };
  }, [orderNumber]);

  if (!refunds || refunds.length === 0) return null;

  return (
    <section aria-labelledby="refunds-heading" className="rounded-card border border-ink-200 bg-shell p-5">
      <h2 id="refunds-heading" className="label-wide text-ink">Refunds</h2>
      <ul className="mt-3 flex flex-col divide-y divide-ink-100">
        {refunds.map((refund) => (
          <li key={refund.refundNumber} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-ink">{formatMoney(refund.amount, { showDecimals: true })}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[0.6875rem] font-medium", TONE[refund.status])}>
                {refund.statusLabel}
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-500">
              {refund.refundNumber} · {refund.reason} · requested {formatDate(refund.requestedAt)}
              {refund.completedAt ? ` · refunded ${formatDate(refund.completedAt)}` : ""}
            </p>
            {refund.items.length ? (
              <p className="mt-1 text-xs text-ink-600">
                {refund.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")}
                {refund.shippingAmount ? ` · delivery ${formatMoney(refund.shippingAmount, { showDecimals: true })}` : ""}
              </p>
            ) : null}
            <ul className="mt-1 text-xs text-ink-600">
              {refund.destinations.map((destination) => (
                <li key={destination.kind}>
                  {formatMoney(destination.amount, { showDecimals: true })} to {destination.label.toLowerCase()}
                </li>
              ))}
            </ul>
            {refund.status !== "completed" ? (
              <p className="mt-1 text-[0.6875rem] text-ink-500">
                {refund.method === "store-credit"
                  ? "Store credit appears in your wallet as soon as it's refunded."
                  : "Refunds to a card or UPI usually reach you within 5–7 working days of being sent."}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
