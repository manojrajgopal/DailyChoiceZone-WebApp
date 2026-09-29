/**
 * The order pipeline — one definition for the admin portal and the storefront.
 *
 * Mirrors `ORDER_FLOW` and `classify_transition` in
 * `backend/app/services/orders.py`. The server enforces the rules; this copy
 * decides what to offer and when to ask "are you sure?", so the two must agree.
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
    label: "Processing",
    customerLabel: "Processing",
    description: "Being picked and checked in the warehouse.",
  },
  packed: {
    label: "Packed",
    customerLabel: "Packed",
    description: "Packed and waiting for the courier.",
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

const CANCELLABLE_FROM = new Set<string>(["pending", "confirmed", "processing", "packed"]);
const RETURNABLE_FROM = new Set<string>(["shipped", "in-transit", "out-for-delivery", "delivered"]);
const TERMINAL = new Set<string>(["cancelled", "returned"]);

export function stageLabel(status: string): string {
  return ORDER_STAGES[status as OrderStatusKey]?.label ?? status;
}

export function customerStageLabel(status: string): string {
  return ORDER_STAGES[status as OrderStatusKey]?.customerLabel ?? status;
}

export function flowIndex(status: string): number {
  return (ORDER_FLOW as readonly string[]).indexOf(status);
}

export type MoveKind = "next" | "skip" | "back" | "cancel" | "return";

export interface Move {
  target: OrderStatusKey;
  kind: MoveKind;
  /** Stages passed over by a skip, or the stage being stepped back from. */
  detail: string;
}

/**
 * Every status an order can be moved to from where it is, and what kind of
 * move each is. Needs-confirmation moves are "skip" and "back".
 *
 * `awaitingPayment` is a checkout order whose stock is held for a payment that
 * has not arrived — only the payment can confirm it, so it may only be
 * cancelled.
 */
export function availableMoves(status: string, awaitingPayment = false): Move[] {
  if (TERMINAL.has(status)) return [];
  const here = flowIndex(status);
  const moves: Move[] = [];

  if (here >= 0 && !(status === "pending" && awaitingPayment)) {
    ORDER_FLOW.forEach((target, there) => {
      if (there === here) return;
      if (there > here) {
        const skipped = ORDER_FLOW.slice(here + 1, there).map(stageLabel);
        moves.push({
          target,
          kind: there === here + 1 ? "next" : "skip",
          detail: skipped.length ? `Skips ${skipped.join(", ")}` : "",
        });
      } else if (target !== "pending" && status !== "delivered") {
        moves.push({ target, kind: "back", detail: `Back from ${stageLabel(status)}` });
      }
    });
  }

  if (CANCELLABLE_FROM.has(status)) moves.push({ target: "cancelled", kind: "cancel", detail: "" });
  if (RETURNABLE_FROM.has(status)) moves.push({ target: "returned", kind: "return", detail: "" });

  // Next step first, then forward skips, then backward moves, then the exits.
  const order: Record<MoveKind, number> = { next: 0, skip: 1, back: 2, cancel: 3, return: 3 };
  return moves.sort(
    (a, b) => order[a.kind] - order[b.kind] || flowIndex(a.target) - flowIndex(b.target),
  );
}

export function needsConfirmation(move: Move | undefined): boolean {
  return move?.kind === "skip" || move?.kind === "back";
}
