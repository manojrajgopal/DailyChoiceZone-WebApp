/**
 * One order's fulfilment, as `GET /admin/orders/{id}/fulfilment` returns it
 * (docs/order-fulfilment.md). Every decision here — which step is current,
 * which actions exist, whether they are allowed — is the server's; the
 * order page only draws it.
 */

import type { ShipmentTransition } from "@/types/shipping";

export type StepState = "completed" | "current" | "upcoming" | "skipped" | "exception" | "cancelled";

export interface LifecycleStep {
  key: string;
  label: string;
  phase: "order" | "packing" | "shipment";
  optional: boolean;
  state: StepState;
}

export interface FulfilmentProgress {
  currentStep: string;
  /** delivery-attempted | delivery-failed | returned-to-origin, or "". */
  exception: string;
  /** cancelled | returned, or "". */
  terminal: string;
  /** Dispatched with no packing or shipment record (from before the workflow was enforced). */
  legacy: boolean;
  steps: LifecycleStep[];
}

export type FulfilmentActionKind = "order" | "shipment" | "create-shipment" | "link";

export interface FulfilmentAction {
  /** confirm | start-packing | begin-packing | repack | cancel | record-return | create-shipment | open-packing | shipment:<status> … */
  key: string;
  label: string;
  kind: FulfilmentActionKind;
  allowed: boolean;
  /** Why it can't be taken yet: payment, permission, no courier, an open shipment. */
  blockedReason: string;
  primary: boolean;
  requiresReason: boolean;
  destructive: boolean;
  description: string;
  target?: string;
  shipmentId?: number;
  href?: string;
}

export interface FulfilmentPackage {
  packageNumber: string;
  type: string;
  weightGrams: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  itemCount: number;
}

export interface FulfilmentPacking {
  id: number;
  status: string;
  statusLabel: string;
  priority: string;
  assignedTo: string;
  pickingStartedAt: string | null;
  pickedAt: string | null;
  packingStartedAt: string | null;
  packedAt: string | null;
  packedBy: string;
  notes: string;
  packageCount: number;
  packages: FulfilmentPackage[];
  href: string;
}

export interface FulfilmentShipment {
  id: number;
  shipmentNumber: string;
  status: string;
  statusLabel: string;
  courierName: string;
  courierCode: string;
  providerCode: string;
  awb: string;
  expectedDeliveryAt: string | null;
  deliveredAt: string | null;
  pickupScheduledAt: string | null;
  createdAt: string;
  labelStatus: string;
  deliveryAttempts: number;
  requestStatus: string;
  lastError: string;
  transitions: ShipmentTransition[];
  href: string;
}

export interface FulfilmentHistoryEntry {
  at: string;
  kind: "order" | "packing" | "shipment";
  status: string;
  statusLabel: string;
  fromStatus: string;
  title: string;
  note: string;
  reason: string;
  location?: string;
  source: string;
  actor: string;
  actorName: string;
  entity: { type: string; id: string; shipmentId?: number } | null;
}

export interface FulfilmentReturn {
  id: string;
  kind: string;
  status: string;
  statusLabel: string;
  reason: string;
  href: string;
}

export interface OrderFulfilment {
  order: {
    id: string;
    orderNumber: string;
    status: string;
    statusLabel: string;
    paymentStatus: string;
    paymentMethod: string;
    stockState: string;
  };
  payment: { status: string; method: string; blocked: string | null };
  progress: FulfilmentProgress;
  nextActions: FulfilmentAction[];
  packing: FulfilmentPacking | null;
  shipment: FulfilmentShipment | null;
  shipments: { id: number; shipmentNumber: string; status: string; statusLabel: string; createdAt: string; href: string }[];
  returns: FulfilmentReturn[];
  warnings: { code: string; message: string }[];
  history: FulfilmentHistoryEntry[];
}
