/** Returns and replacements — see `backend/app/services/returns.py`. */

export type ReturnKind = "return" | "replacement";

export type ReturnStatus =
  | "requested"
  | "approved"
  | "rejected"
  | "cancelled"
  | "picked-up"
  | "received"
  | "refunded"
  | "replacement-shipped"
  | "completed";

export interface ReturnEligibleItem {
  orderItemId: number;
  productId: string;
  name: string;
  image: string;
  size: string | null;
  color: string | null;
  quantity: number;
  /** Units not yet in a request. */
  available: number;
  /** Can be returned right now (policy, window and units allowing). */
  returnable: boolean;
  replaceable: boolean;
  /** The policy it was bought under, whatever the window. */
  isReturnable: boolean;
  isReplaceable: boolean;
}

export interface ReturnEligibility {
  eligible: boolean;
  /** Why nothing can be sent back — written for the customer. Empty when something can. */
  reason: string;
  windowDays: number;
  windowEndsAt: string | null;
  reasons: Record<ReturnKind, string[]>;
  items: ReturnEligibleItem[];
}

export interface ReturnRequestItem {
  orderItemId: number;
  productId: string;
  name: string;
  image: string;
  size: string | null;
  color: string | null;
  quantity: number;
  /** Minor units (paise). */
  amount: number;
}

export interface ReturnRequest {
  id: string;
  orderId: string;
  orderNumber: string;
  kind: ReturnKind;
  status: ReturnStatus;
  reason: string;
  comment: string;
  resolutionNote: string;
  /** Minor units (paise). */
  amount: number;
  refundId: string | null;
  createdAt: string;
  updatedAt: string;
  canCancel: boolean;
  items: ReturnRequestItem[];
  timeline: { status: ReturnStatus; note: string; by: string; at: string }[];
  // Admin only.
  customerId?: string;
  customerName?: string;
  nextSteps?: ReturnStatus[];
}

/** The stages each kind moves through, in order, for trackers. */
export const RETURN_STAGES: Record<ReturnKind, ReturnStatus[]> = {
  return: ["requested", "approved", "picked-up", "received", "refunded"],
  replacement: ["requested", "approved", "picked-up", "received", "replacement-shipped", "completed"],
};

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  rejected: "Declined",
  cancelled: "Cancelled",
  "picked-up": "Picked up",
  received: "Received",
  refunded: "Refunded",
  "replacement-shipped": "Replacement shipped",
  completed: "Completed",
};
