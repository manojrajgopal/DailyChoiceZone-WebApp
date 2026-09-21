import type { OrderStatus } from "@/types";

import { Badge } from "@/components/ui/Badge";

/** Human-readable labels and a tone per order status. */
const STATUS: Record<OrderStatus, { label: string; tone: "stock" | "neutral" | "new" | "soldout" }> = {
  placed: { label: "Placed", tone: "neutral" },
  confirmed: { label: "Confirmed", tone: "new" },
  shipped: { label: "Shipped", tone: "new" },
  "out-for-delivery": { label: "Out for delivery", tone: "new" },
  delivered: { label: "Delivered", tone: "stock" },
  cancelled: { label: "Cancelled", tone: "soldout" },
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const entry = STATUS[status] ?? STATUS.placed;
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

/** The happy-path stages, in order, for the tracker on an order page. */
export const ORDER_TIMELINE: OrderStatus[] = [
  "confirmed",
  "shipped",
  "out-for-delivery",
  "delivered",
];

export function statusLabel(status: OrderStatus): string {
  return (STATUS[status] ?? STATUS.placed).label;
}
