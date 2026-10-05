/**
 * Shipments, couriers and delivery estimates — exactly the shapes in
 * `docs/shipping-and-suppliers.md`, sections 3, 4 and 6. Money is in rupees,
 * timestamps are the API's zone-less UTC strings.
 */

/* ------------------------------------------------------------------ status */

export type ShipmentStatus =
  | "pending"
  | "ready-for-pickup"
  | "pickup-scheduled"
  | "picked-up"
  | "in-transit"
  | "at-destination-hub"
  | "out-for-delivery"
  | "delivered"
  | "delivery-attempted"
  | "delivery-failed"
  | "returned-to-origin"
  | "cancelled";

/** Fallback labels, for when a row arrives without its own `statusLabel`. */
export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = {
  pending: "Shipment created",
  "ready-for-pickup": "Ready for pickup",
  "pickup-scheduled": "Pickup scheduled",
  "picked-up": "Picked up",
  "in-transit": "In transit",
  "at-destination-hub": "At destination hub",
  "out-for-delivery": "Out for delivery",
  delivered: "Delivered",
  "delivery-attempted": "Delivery attempted",
  "delivery-failed": "Delivery failed",
  "returned-to-origin": "Returned to origin",
  cancelled: "Cancelled",
};

/** In lifecycle order, for filters and the manual-event picker. */
export const SHIPMENT_STATUSES = Object.keys(SHIPMENT_STATUS_LABELS) as ShipmentStatus[];

export function shipmentStatusLabel(status: string, label?: string | null): string {
  if (label) return label;
  return SHIPMENT_STATUS_LABELS[status as ShipmentStatus] ?? status;
}

export type RequestStatus = "ok" | "pending" | "failed";

/* ---------------------------------------------------------------- customer */

export interface CustomerShipmentEvent {
  status: string;
  label: string;
  description: string;
  location: string;
  occurredAt: string;
  source: "courier" | "store";
}

export interface CustomerShipment {
  shipmentNumber: string;
  status: ShipmentStatus;
  statusLabel: string;
  courierName: string;
  service: string;
  awb: string;
  /** A courier page link when the provider gives one; "" otherwise. */
  trackingUrl: string;
  expectedDeliveryAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  /** Oldest first, customer-visible only. */
  events: CustomerShipmentEvent[];
}

export interface DeliveryEstimate {
  pincode: string;
  source: "store" | "courier" | "none";
  /** null: couldn't tell (the courier was unreachable). */
  serviceable: boolean | null;
  codAvailable: boolean | null;
  etaDays: { min: number; max: number } | null;
  /** e.g. "Delivery by Thu, 9 Oct", or "". */
  label: string;
  message: string;
}

/* -------------------------------------------------------- admin: shipments */

export interface ShipmentOrderItem {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  size: string | null;
  color: string | null;
  lineTotal: number;
}

export interface ShipmentOrder {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  total: number;
  placedAt: string;
  customer: { id: string; name: string; email: string; phone: string };
  items: ShipmentOrderItem[];
}

export interface ShipmentPackage {
  weightGrams: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  count: number | null;
  type: string | null;
}

export interface ShipmentAddress {
  name?: string;
  phone?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

export type ShipmentEventSource = "webhook" | "poll" | "admin" | "system";

export interface ShipmentEvent {
  id: number;
  status: string;
  label: string;
  providerStatus: string;
  description: string;
  location: string;
  occurredAt: string;
  receivedAt: string;
  source: ShipmentEventSource;
  actor: string;
  visible: boolean;
}

export interface ShipmentTechnical {
  requestStatus: RequestStatus;
  lastOperation: string;
  lastError: string;
  lastErrorAt: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  lastSyncedAt: string | null;
  lastWebhookAt: string | null;
}

/** Which buttons the server allows right now. The UI shows only these. */
export interface ShipmentActions {
  label: boolean;
  pickup: boolean;
  cancel: boolean;
  refresh: boolean;
  retry: boolean;
  manualEvent: boolean;
  editPackage: boolean;
}

export interface Shipment {
  id: number;
  shipmentNumber: string;
  status: ShipmentStatus;
  statusLabel: string;
  order: ShipmentOrder;
  provider: { code: string; name: string };
  courierName: string;
  courierCode: string;
  service: string;
  awb: string;
  providerShipmentId: string;
  providerOrderId: string;
  package: ShipmentPackage;
  cod: boolean;
  codAmount: number;
  declaredValue: number;
  origin: ShipmentAddress;
  destination: ShipmentAddress;
  expectedDeliveryAt: string | null;
  deliveredAt: string | null;
  label: { available: boolean; url: string };
  pickup: { status: "scheduled" | "" | "failed"; scheduledAt: string | null; token: string };
  events: ShipmentEvent[];
  technical: ShipmentTechnical;
  actions: ShipmentActions;
  /** The manual moves allowed from here, decided by the server (docs/order-fulfilment.md). */
  transitions?: ShipmentTransition[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

/** One manual shipment move the server allows from the current status. */
export interface ShipmentTransition {
  status: ShipmentStatus;
  label: string;
  /** What the button says: "Mark picked up", "Delivery attempted"… */
  action: string;
  kind: "forward" | "exception" | "back" | "cancel";
  requiresReason: boolean;
}

export interface ShipmentTransitionInput {
  status: string;
  reason?: string;
  description?: string;
  location?: string;
  occurredAt?: string;
  visible?: boolean;
}

/** Around the shipment list: packed orders waiting, and orders missing a shipment record. */
export interface PipelineOrder {
  orderId: string;
  orderNumber: string;
  customerName: string;
  status: string;
  statusLabel: string;
  paymentStatus: string;
  placedAt: string;
  packedAt: string | null;
  packingJobId: number | null;
  packageCount: number;
}

export interface ShipmentPipeline {
  readyToShip: { count: number; items: PipelineOrder[] };
  missingShipments: { count: number; items: PipelineOrder[] };
  deliveredWithoutShipment: number;
  couriersActive: boolean;
}

/** A row of the shipments list (and of an order's shipping summary). */
export interface ShipmentSummary {
  id: number;
  shipmentNumber: string;
  status: ShipmentStatus;
  statusLabel: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  courierName: string;
  awb: string;
  providerCode: string;
  requestStatus: RequestStatus;
  lastError: string;
  expectedDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The store's own label (see types/packing `LabelStatus`). */
  labelStatus?: "not-generated" | "generating" | "generated" | "failed" | "regenerated" | "cancelled";
  orderStatus?: string;
  /** Delivery attempted, failed or returned to origin. */
  exception?: boolean;
  /** The next forward step, when there is one. */
  nextAction?: ShipmentTransition | null;
}

export interface ShipmentList {
  items: ShipmentSummary[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  counts?: Record<string, number>;
}

export interface ShipmentFilters {
  /** A Shipment ID (number or AWB) or an Order ID, matched exactly. */
  q?: string;
  /** An Order ID, matched exactly. */
  order?: string;
  status?: string;
  /** A courier's code, matched exactly. */
  courier?: string;
  provider?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface ProviderSupports {
  rates: boolean;
  label: boolean;
  pickup: boolean;
  tracking: boolean;
  cancel: boolean;
  manualAwb: boolean;
}

/** A provider as offered on an order's shipping options. */
export interface ShippingOption {
  code: string;
  name: string;
  isDefault: boolean;
  services: string[];
  supports: ProviderSupports;
}

export interface OrderShipping {
  order: ShipmentOrder;
  destination: ShipmentAddress;
  shipments: ShipmentSummary[];
  activeShipmentId: number | null;
  canCreate: boolean;
  /** Why `canCreate` is false. */
  reason: string;
  reasonCode?: string;
  /** normal, record-missing (dispatched with no shipment on record) or reship (after a return to origin). */
  createMode?: "normal" | "record-missing" | "reship";
  /** The order's packing job, with its packed parcels aggregated for the shipment (null when not packed). */
  packing?: { jobId: number; status: string; statusLabel: string; package: Partial<ShipmentPackage> | null } | null;
  providers: ShippingOption[];
  defaultPackage: Partial<ShipmentPackage> | null;
}

export interface RateOption {
  courierCode: string;
  courierName: string;
  rate: number;
  /** The contract doesn't pin this down: a day count, or a range. */
  etaDays: number | { min: number; max: number } | null;
  estimatedDeliveryAt: string | null;
  codAvailable: boolean;
}

export interface RatesResult {
  options: RateOption[];
  source: string;
}

/** What the create dialog sends. Blank package fields are left out. */
export interface PackageInput {
  weightGrams?: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  count?: number;
  type?: string;
}

export interface CreateShipmentInput {
  orderId: string;
  providerCode: string;
  service: string;
  courierCode?: string;
  courierName?: string;
  awb?: string;
  package: PackageInput;
  idempotencyKey: string;
}

export interface ManualEventInput {
  status: string;
  description: string;
  location: string;
  occurredAt: string;
  visible: boolean;
  /** Required for exceptions and backward moves. */
  reason?: string;
}

/* -------------------------------------------------------- admin: providers */

export interface ProviderOrigin {
  name: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
}

export interface ProviderSettings {
  defaultService: string;
  services: string[];
  /** Shiprocket's pickup nickname. */
  pickupLocation?: string;
  origin: ProviderOrigin;
  checkoutServiceability: boolean;
  defaultPackage?: Partial<ShipmentPackage> | null;
}

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
}

export interface ShippingProviderConfig {
  code: string;
  name: string;
  available: boolean;
  description: string;
  environment: string;
  environments: string[];
  active: boolean;
  isDefault: boolean;
  settings: ProviderSettings;
  credentialFields: CredentialField[];
  /** Masked: which fields are set, never their values. */
  credentials: Record<string, string>;
  configured: boolean;
  webhookUrl: string;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastError: string;
  supports: Partial<ProviderSupports>;
}

export interface ProviderUpdate {
  name?: string;
  environment?: string;
  active?: boolean;
  isDefault?: boolean;
  settings?: ProviderSettings;
  /** Only the fields being changed; a blank or omitted one keeps the stored value. */
  credentials?: Record<string, string>;
}
