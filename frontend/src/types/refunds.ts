/**
 * Partial refunds, as the API sends them. Every amount is in paise; the
 * figures are always the server's (`backend/app/services/refunds.py`) — the
 * portal shows them and never adds anything up itself.
 */

export type RefundState = "requested" | "processing" | "completed" | "failed" | "cancelled" | "rejected";
export type RefundMethod = "original" | "store-credit";

export const REFUND_METHOD_LABELS: Record<RefundMethod, string> = {
  original: "Original payment method",
  "store-credit": "Store credit",
};

export interface RefundBreakdownLine {
  orderItemId: number;
  invoiceItemId: number | null;
  productId: string;
  name: string;
  sku: string;
  image: string;
  size: string;
  color: string;
  hsn: string;
  ordered: number;
  cancelled: number;
  returned: number;
  refunded: number;
  refundable: number;
  unitPrice: number;
  lineTotal: number;
  lineDiscount: number;
  lineTax: number;
  taxRatePercent: number;
  remainingAmount: number;
  quantity: number;
  gross: number;
  discount: number;
  amount: number;
  taxable: number;
  tax: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface RefundBreakdown {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  invoiceId: string;
  invoiceNumber: string;
  currency: string;
  paymentMethod: string;
  paymentStatus: string;
  isCod: boolean;
  taxMode: string;
  paid: { total: number; payment: number; tenders: number; grandTotal: number };
  refunded: number;
  remaining: number;
  remainingByDestination: { payment: number; tenders: number };
  lines: RefundBreakdownLine[];
  shipping: { charged: number; refunded: number; refundable: number; amount: number };
  adjustment: number;
  totals: {
    items: number; gross: number; discount: number; shipping: number; adjustment: number;
    taxable: number; tax: number; cgst: number; sgst: number; igst: number; total: number;
  };
  split: { payment: number; tenders: number };
  fullRefund: boolean;
  suggestShipping: boolean;
  method: RefundMethod;
  allowedMethods: RefundMethod[];
  approvalThreshold: number;
  requiresApproval: boolean;
  reasonCodes: { code: string; label: string }[];
}

export interface RefundRecord {
  id: string;
  refundNumber: string;
  orderId: string;
  orderNumber: string;
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  customerId: string;
  customerName: string;
  amount: number;
  paymentAmount: number;
  tenderAmount: number;
  shippingAmount: number;
  taxAmount: number;
  discountAmount: number;
  method: RefundMethod;
  methodLabel: string;
  reasonCode: string;
  reasonLabel: string;
  reason: string;
  internalNote: string;
  status: RefundState;
  statusLabel: string;
  requiresApproval: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  initiatedBy: string;
  gatewayReference: string;
  manualReference: string;
  failureReason: string;
  attempts: number;
  lastAttemptAt: string | null;
  nextCheckAt: string | null;
  creditNoteId: string | null;
  requestedAt: string;
  processedAt: string | null;
  canApprove: boolean;
  canRetry: boolean;
  canCancel: boolean;
  items: {
    orderItemId: number; invoiceItemId: number | null; productId: string; name: string; quantity: number;
    amount: number; discount: number; taxable: number; taxRatePercent: number; cgst: number; sgst: number;
    igst: number; tax: number;
  }[];
}

export interface OrderRefunds {
  breakdown: RefundBreakdown;
  refunds: RefundRecord[];
}

export interface RefundRequest {
  lines: { orderItemId: number; quantity: number }[];
  fullRefund?: boolean;
  includeShipping?: boolean;
  /** Paise; omitted with `includeShipping` for all the delivery fee still refundable. */
  shippingAmount?: number;
  adjustmentAmount?: number;
  method?: RefundMethod;
}

export interface CreateRefundRequest extends RefundRequest {
  idempotencyKey: string;
  reasonCode: string;
  reason?: string;
  internalNote?: string;
  manualReference?: string;
  processNow?: boolean;
}

export interface RefundSettings {
  allowedMethods: RefundMethod[];
  /** Rupees; 0 for no threshold. */
  approvalThreshold: number;
  returnsSkipApproval: boolean;
  returnsMethod: RefundMethod;
  codMethod: RefundMethod;
  includeShippingOnFullRefund: boolean;
  autoCreditNote: boolean;
  pollMinutes: number;
  maxAttempts: number;
  methods: RefundMethod[];
}

/** What a customer sees of a refund: no notes, references or staff. */
export interface CustomerRefund {
  refundNumber: string;
  orderNumber: string;
  amount: number;
  method: RefundMethod;
  methodLabel: string;
  destinations: { kind: string; amount: number; label: string }[];
  reason: string;
  status: "requested" | "processing" | "completed";
  statusLabel: string;
  requestedAt: string;
  completedAt: string | null;
  shippingAmount: number;
  items: { name: string; quantity: number; amount: number }[];
}
