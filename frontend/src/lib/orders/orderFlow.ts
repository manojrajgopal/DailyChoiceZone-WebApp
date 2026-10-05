/**
 * The order stages and their labels — one definition for the admin portal and
 * the storefront.
 *
 * Which moves are allowed is **not** decided here. The server owns the
 * fulfilment workflow (`backend/app/services/fulfilment/workflow.py`,
 * docs/order-fulfilment.md) and tells the order page which actions exist
 * (`GET /admin/orders/{id}/fulfilment`). This file only names the stages.
 */

export const ORDER_FLOW = [
  "pending",
  "confirmed",
  "processing",
  "packed",
  "shipped",
  "in-transit",
  "out-for-delivery",
  "delivered",
] as const;

export type FlowStatus = (typeof ORDER_FLOW)[number];
export type OrderStatusKey = FlowStatus | "cancelled" | "returned";

interface StageInfo {
  /** What the admin portal calls it. */
  label: string;
  /** What the customer sees — "Order placed", not "Pending". */
  customerLabel: string;
  /** One line on what the stage means. */
  description: string;
}

export const ORDER_STAGES: Record<OrderStatusKey, StageInfo> = {
  pending: {
    label: "Pending",
    customerLabel: "Order placed",
    description: "Placed and awaiting confirmation or payment.",
  },
  confirmed: {
    label: "Confirmed",
    customerLabel: "Confirmed",
    description: "Payment received or cash on delivery accepted.",
  },
  processing: {
    label: "Packing",
    customerLabel: "Being packed",
    description: "Being picked and packed in the warehouse.",
  },
  packed: {
    label: "Packed",
    customerLabel: "Packed",
    description: "Packed and ready for a shipment to be created.",
  },
  shipped: {
    label: "Shipped",
    customerLabel: "Shipped",
    description: "Dispatched from the warehouse and handed to the courier.",
  },
  "in-transit": {
    label: "In transit",
    customerLabel: "In transit",
    description: "Moving through the courier's network.",
  },
  "out-for-delivery": {
    label: "Out for delivery",
    customerLabel: "Out for delivery",
    description: "With the delivery agent, arriving today.",
  },
  delivered: {
    label: "Delivered",
    customerLabel: "Delivered",
    description: "Handed over to the customer.",
  },
  cancelled: {
    label: "Cancelled",
    customerLabel: "Cancelled",
    description: "Cancelled before dispatch.",
  },
  returned: {
    label: "Returned",
    customerLabel: "Returned",
    description: "Returned after dispatch.",
  },
};

/** Customers can cancel online only until the warehouse starts picking. */
export const CUSTOMER_CANCELLABLE: ReadonlySet<string> = new Set(["pending", "confirmed"]);

export function stageLabel(status: string): string {
  return ORDER_STAGES[status as OrderStatusKey]?.label ?? status;
}

export function customerStageLabel(status: string): string {
  return ORDER_STAGES[status as OrderStatusKey]?.customerLabel ?? status;
}

export function flowIndex(status: string): number {
  return (ORDER_FLOW as readonly string[]).indexOf(status);
}
