/**
 * Packing and shipping labels, as the portal reads them.
 * The shapes mirror `backend/app/services/fulfilment/packing.py` (`detail_view`,
 * `search`, `summary`) and `labels.py` (`view`, `overview`, `bulk_generate`).
 */

export type PackingStatus = "pending" | "picking" | "picked" | "packing" | "packed" | "ready-to-ship" | "cancelled";
export type PackingPriority = "normal" | "high" | "urgent";
export type PickException = "missing-stock" | "damaged" | "wrong-item";
export type PackageType = "box" | "envelope" | "polybag" | "tube" | "crate" | "other";

export const PACKING_STATUSES: PackingStatus[] = [
  "pending", "picking", "picked", "packing", "packed", "ready-to-ship", "cancelled",
];

export const PACKING_STATUS_LABELS: Record<PackingStatus, string> = {
  pending: "Waiting to pick",
  picking: "Picking",
  picked: "Picked",
  packing: "Packing",
  packed: "Packed · ready to ship",
  "ready-to-ship": "Handed to shipping",
  cancelled: "Cancelled",
};

export const PRIORITY_LABELS: Record<PackingPriority, string> = { normal: "Normal", high: "High", urgent: "Urgent" };

export const EXCEPTION_LABELS: Record<PickException, string> = {
  "missing-stock": "Missing stock",
  damaged: "Damaged",
  "wrong-item": "Wrong item",
};

export interface Aging {
  hours: number;
  slaHours: number;
  overdue: boolean;
}

export interface StaffRef {
  id: string;
  name: string;
}

export interface PackingQueueRow {
  id: number;
  status: PackingStatus;
  statusLabel: string;
  priority: PackingPriority;
  orderId: string;
  orderNumber: string;
  customerName: string;
  placedAt: string;
  paymentStatus: string;
  paymentMethod: string;
  total: number;
  itemCount: number;
  shippingMethod: string;
  courierName: string;
  assignedTo: StaffRef | null;
  createdAt: string;
  aging: Aging;
}

export interface PackingQueue {
  items: PackingQueueRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  counts: Partial<Record<PackingStatus, number>>;
  slaHours: number;
}

export interface PackingQueueFilters {
  q?: string;
  status?: string;
  scope?: "open" | "all";
  from?: string;
  to?: string;
  paymentStatus?: string;
  courier?: string;
  priority?: string;
  assignedTo?: string;
  shippingType?: string;
  overdue?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PackingLineView {
  id: number;
  orderItemId: number;
  productId: string;
  name: string;
  sku: string;
  size: string;
  color: string;
  image: string;
  quantity: number;
  pickedQty: number;
  remainingQty: number;
  allocatedQty: number;
  pickedAt: string | null;
  pickedBy: string | null;
  exception: { type: PickException; label: string; quantity: number; note: string; by: string; at: string } | null;
  damagedRecordedQty: number;
}

export interface PackageView {
  id: number;
  packageNumber: string;
  weightGrams: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  volumetricWeightKg: number | null;
  type: PackageType;
  notes: string;
  packedBy: string | null;
  packedAt: string | null;
  shipmentId: number | null;
  createdAt: string;
  createdBy: string;
  items: { lineId: number; quantity: number; name: string; sku: string; size: string; color: string }[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PackingValidation {
  ready: boolean;
  /** Can't be overridden. */
  errors: ValidationIssue[];
  /** Can be overridden, with a confirmation and a reason. */
  critical: ValidationIssue[];
}

export interface PackingActions {
  assign: boolean;
  startPicking: boolean;
  pick: boolean;
  completePicking: boolean;
  startPacking: boolean;
  editPackages: boolean;
  markPacked: boolean;
  reopen: boolean;
  ready: boolean;
  slip: boolean;
}

export interface PackingEventView {
  id: number;
  action: string;
  fromStatus: string;
  toStatus: string;
  note: string;
  details: Record<string, unknown>;
  actor: string;
  actorName: string;
  at: string;
}

export interface DefaultPackage {
  weightGrams: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  type: PackageType;
}

export interface PackingJob {
  id: number;
  status: PackingStatus;
  statusLabel: string;
  priority: PackingPriority;
  assignedTo: StaffRef | null;
  assignedAt: string | null;
  order: {
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    paymentMethod: string;
    deliveryMethod: string;
    total: number;
    itemCount: number;
    placedAt: string;
    customer: { id: string; name: string; email: string; phone: string };
    shippingAddress: Record<string, string>;
  } | null;
  lines: PackingLineView[];
  packages: PackageView[];
  aggregate: { weightGrams: number | null; lengthCm: number | null; widthCm: number | null; heightCm: number | null;
    count: number; type: PackageType } | null;
  shipment: { id: number; shipmentNumber: string; status: string; courierName: string; awb: string; linked: boolean }
    | null;
  validation: PackingValidation;
  actions: PackingActions;
  aging: Aging | null;
  pickOverrideReason: string;
  packOverrideReason: string;
  volumetricDivisor: number;
  slipShowPrices: boolean;
  defaultPackage: DefaultPackage | null;
  events: PackingEventView[];
  timestamps: Record<string, string | null>;
}

export interface PackageInput {
  weightGrams: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  type: PackageType;
  notes?: string;
  /** Empty: everything picked that isn't in a package yet. */
  items?: { lineId: number; quantity: number }[];
}

export interface PackingSummary {
  waitingToPick: number;
  waitingToPack: number;
  /** Packed, waiting for a shipment to be created. */
  readyToShip?: number;
  packedToday: number;
  overdue: number;
  slaHours: number;
  labelsPending: number;
  labelsGeneratedToday: number;
  labelFailures: number;
}

export interface OrderPackingCard {
  job: {
    id: number;
    status: PackingStatus;
    statusLabel: string;
    priority: PackingPriority;
    packageCount: number;
    packedAt: string | null;
    assignedTo: string;
  } | null;
}

/* ---------------------------------------------------------------- labels */

export type LabelStatus = "not-generated" | "generating" | "generated" | "failed" | "regenerated" | "cancelled";

export const LABEL_STATUS_LABELS: Record<LabelStatus, string> = {
  "not-generated": "Not generated",
  generating: "Generating",
  generated: "Generated",
  failed: "Failed",
  regenerated: "Superseded",
  cancelled: "Cancelled",
};

export interface LabelFormat {
  key: string;
  name: string;
  widthMm: number;
  heightMm: number;
}

export interface LabelVersion {
  id: number;
  shipmentId: number;
  version: number;
  status: LabelStatus;
  statusLabel: string;
  format: string;
  formatName: string;
  current: boolean;
  pageCount: number;
  generatedBy: string;
  generatedAt: string | null;
  reason: string;
  providerReference: string;
  externalUrl: string;
  errorCode: string;
  errorMessage: string;
  cancelledAt: string | null;
  cancelReason: string;
  supersededAt: string | null;
  createdAt: string;
  printable: boolean;
}

export interface LabelOverview {
  shipmentId: number;
  status: LabelStatus;
  current: LabelVersion | null;
  history: LabelVersion[];
  problems: ValidationIssue[];
  canGenerate: boolean;
  courierLabelUrl: string;
  formats: LabelFormat[];
  defaultFormat: string;
}

export interface BulkLabelResult {
  results: ({ shipmentId: number; ok: true; created: boolean; label: LabelVersion }
    | { shipmentId: number; ok: false; error: { code: string; message: string } })[];
  succeeded: number;
  failed: number;
}

export interface FulfilmentSettings {
  slaHours: number;
  volumetricDivisor: number;
  slipShowPrices: boolean;
  labelFormat: string;
  defaultPackage: DefaultPackage | null;
  formats: LabelFormat[];
  packageTypes: PackageType[];
}
