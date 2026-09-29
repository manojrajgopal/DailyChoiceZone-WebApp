import type { OrderStatus } from "@/types";

import { Badge } from "@/components/ui/Badge";
import { ORDER_FLOW, customerStageLabel } from "@/lib/orders/orderFlow";

type Tone = "stock" | "neutral" | "new" | "soldout";

/** A tone per order status; the labels come from `lib/orders/orderFlow`. */
const TONES: Record<OrderStatus, Tone> = {
  pending: "neutral",
  confirmed: "new",
  processing: "new",
  packed: "new",
  shipped: "new",
  "in-transit": "new",
  "out-for-delivery": "new",
  delivered: "stock",
  cancelled: "soldout",
  returned: "soldout",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={TONES[status] ?? "neutral"}>{customerStageLabel(status)}</Badge>;
}

/** Every stage, in order, for the tracker on an order page. */
export const ORDER_TIMELINE: OrderStatus[] = [...ORDER_FLOW];

export function statusLabel(status: OrderStatus): string {
  return customerStageLabel(status);
}
