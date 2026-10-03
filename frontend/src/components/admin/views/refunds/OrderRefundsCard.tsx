"use client";

import { useState } from "react";
import { Undo2 } from "lucide-react";

import { AdminButton, AdminCard } from "@/components/admin/ui/AdminChrome";
import { useAdminResource } from "@/hooks/useAdminResource";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils/format";
import { ApiError } from "@/services/api/client";
import { getOrderRefunds } from "@/services/admin/refundsAdminService";

import { RefundActions, RefundStatusBadge } from "./RefundActions";
import { RefundWizard } from "./RefundWizard";

export { RefundStatusBadge };

const money = (paise: number) => formatMoney(paise, { showDecimals: true });

/**
 * An order's refunds: what's left to refund, each refund with its items and
 * where it stands, the approval, retry and cancel steps the server allows,
 * and the way into the refund wizard. Staff without the refunds permission
 * don't see the card.
 */
export function OrderRefundsCard({ orderId, onChanged }: { orderId: string; onChanged?: () => void }) {
  const loaded = useAdminResource(() => getOrderRefunds(orderId), [orderId]);
  const [wizard, setWizard] = useState(0);

  if (loaded.error instanceof ApiError && (loaded.error.status === 403 || loaded.error.code === "NO_INVOICE")) return null;
  if (!loaded.data) {
    return loaded.error ? null : (
      <AdminCard title="Refunds">
        <span aria-busy="true" aria-label="Loading refunds" className="block h-12 animate-pulse rounded-[2px] bg-admin-border" />
      </AdminCard>
    );
  }

  const { breakdown, refunds } = loaded.data;
  const changed = () => {
    void loaded.reload();
    onChanged?.();
  };

  return (
    <AdminCard
      title="Refunds"
      description={`${money(breakdown.remaining)} of ${money(breakdown.paid.total)} left to refund`}
      action={breakdown.remaining > 0 && breakdown.orderStatus !== "cancelled" ? (
        <AdminButton size="sm" onClick={() => setWizard((value) => value + 1)}>
          <Undo2 className="h-3 w-3" strokeWidth={2} aria-hidden="true" /> Refund items
        </AdminButton>
      ) : null}
    >
      {refunds.length === 0 ? (
        <p className="text-xs text-admin-muted">No refunds on this order.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-admin-border text-xs">
          {refunds.map((refund) => (
            <li key={refund.id} className="py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span>
                  <span className="font-medium text-admin-ink">{refund.refundNumber}</span>
                  <span className="block text-admin-muted">
                    {refund.reasonLabel} · {refund.methodLabel} · {formatDate(refund.requestedAt)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums text-admin-ink">{money(refund.amount)}</span>
                  <RefundStatusBadge refund={refund} />
                </span>
              </div>
              {refund.items.length ? (
                <p className="mt-1 text-admin-muted">
                  {refund.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")}
                  {refund.shippingAmount ? ` · delivery ${money(refund.shippingAmount)}` : ""}
                </p>
              ) : refund.shippingAmount ? (
                <p className="mt-1 text-admin-muted">Delivery {money(refund.shippingAmount)}</p>
              ) : null}
              {refund.status === "failed" && refund.failureReason ? (
                <p className="mt-1 text-[#a12b2b]">{refund.failureReason} (attempt {refund.attempts})</p>
              ) : null}
              {refund.status === "requested" && refund.requiresApproval ? (
                <p className="mt-1 text-[#8a5a12]">Waiting for a manager to approve it.</p>
              ) : null}
              {refund.internalNote ? <p className="mt-1 text-admin-muted">Note: {refund.internalNote}</p> : null}
              <div className="mt-2">
                <RefundActions refund={refund} onChanged={changed} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {wizard ? (
        <RefundWizard key={wizard} orderId={orderId} initial={breakdown} onClose={() => setWizard(0)}
          onDone={() => { setWizard(0); changed(); }} />
      ) : null}

    </AdminCard>
  );
}
