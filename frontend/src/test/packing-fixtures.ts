import type {
  LabelOverview,
  LabelVersion,
  PackageView,
  PackingActions,
  PackingJob,
  PackingLineView,
  PackingQueue,
  PackingQueueRow,
} from "@/types/packing";

const NO_ACTIONS: PackingActions = {
  assign: false, startPicking: false, pick: false, completePicking: false, startPacking: false,
  editPackages: false, markPacked: false, reopen: false, ready: false, slip: false,
};

export function packingActions(patch: Partial<PackingActions> = {}): PackingActions {
  return { ...NO_ACTIONS, ...patch };
}

export function queueRow(patch: Partial<PackingQueueRow> = {}): PackingQueueRow {
  return {
    id: 7, status: "pending", statusLabel: "Waiting to pick", priority: "normal", orderId: "ORD042", orderNumber: "DCZ10042",
    customerName: "Asha Rao", placedAt: "2026-10-01T09:00:00", paymentStatus: "paid", paymentMethod: "upi",
    total: 2498, itemCount: 2, shippingMethod: "standard", courierName: "", assignedTo: null,
    createdAt: "2026-10-01T09:05:00", aging: { hours: 5.2, slaHours: 24, overdue: false },
    ...patch,
  };
}

export function packingQueue(items: PackingQueueRow[] = [queueRow()]): PackingQueue {
  return {
    items, pagination: { page: 1, page_size: 25, total: items.length, total_pages: 1 },
    counts: { pending: items.length }, slaHours: 24,
  };
}

export function packingLine(patch: Partial<PackingLineView> = {}): PackingLineView {
  return {
    id: 31, orderItemId: 501, productId: "P1", name: "Cotton Kurta", sku: "KUR-M-BLU", size: "M", color: "Blue",
    image: "", quantity: 2, pickedQty: 0, remainingQty: 2, allocatedQty: 0, pickedAt: null, pickedBy: null,
    exception: null, damagedRecordedQty: 0,
    ...patch,
  };
}

export function packageView(patch: Partial<PackageView> = {}): PackageView {
  return {
    id: 91, packageNumber: "PKG-1", weightGrams: 850, lengthCm: 30, widthCm: 20, heightCm: 10,
    volumetricWeightKg: 1.2, type: "box", notes: "", packedBy: null, packedAt: null, shipmentId: null,
    createdAt: "2026-10-01T10:00:00", createdBy: "Ravi",
    items: [{ lineId: 31, quantity: 2, name: "Cotton Kurta", sku: "KUR-M-BLU", size: "M", color: "Blue" }],
    ...patch,
  };
}

export function packingJob(patch: Partial<PackingJob> = {}): PackingJob {
  return {
    id: 7, status: "pending", statusLabel: "Waiting to pick", priority: "normal", assignedTo: null, assignedAt: null,
    order: {
      id: "ORD042", orderNumber: "DCZ10042", status: "confirmed", paymentStatus: "paid", paymentMethod: "upi",
      deliveryMethod: "standard", total: 2498, itemCount: 2, placedAt: "2026-10-01T09:00:00",
      customer: { id: "C1", name: "Asha Rao", email: "asha@example.com", phone: "9876543210" },
      shippingAddress: { line1: "12 MG Road", city: "Bengaluru", pincode: "560001" },
    },
    lines: [packingLine()],
    packages: [],
    aggregate: null,
    shipment: null,
    validation: { ready: false, errors: [], critical: [] },
    actions: packingActions({ assign: true, startPicking: true, slip: true }),
    aging: { hours: 5.2, slaHours: 24, overdue: false },
    pickOverrideReason: "", packOverrideReason: "",
    volumetricDivisor: 5000, slipShowPrices: false, defaultPackage: null,
    events: [],
    timestamps: {},
    ...patch,
  };
}

export function labelVersion(patch: Partial<LabelVersion> = {}): LabelVersion {
  return {
    id: 61, shipmentId: 12, version: 1, status: "generated", statusLabel: "Generated", format: "thermal-4x6",
    formatName: "Thermal 4 × 6 in", current: true, pageCount: 1, generatedBy: "Ravi",
    generatedAt: "2026-10-01T11:00:00", reason: "", providerReference: "", externalUrl: "", errorCode: "",
    errorMessage: "", cancelledAt: null, cancelReason: "", supersededAt: null, createdAt: "2026-10-01T11:00:00",
    printable: true,
    ...patch,
  };
}

export function labelOverview(patch: Partial<LabelOverview> = {}): LabelOverview {
  return {
    shipmentId: 12, status: "not-generated", current: null, history: [], problems: [], canGenerate: true,
    courierLabelUrl: "",
    formats: [
      { key: "thermal-4x6", name: "Thermal 4 × 6 in", widthMm: 102, heightMm: 152 },
      { key: "a4", name: "A4", widthMm: 210, heightMm: 297 },
    ],
    defaultFormat: "thermal-4x6",
    ...patch,
  };
}
