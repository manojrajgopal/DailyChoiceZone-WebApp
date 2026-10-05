import type {
  CreateShipmentInput,
  CustomerShipment,
  DeliveryEstimate,
  ManualEventInput,
  OrderShipping,
  PackageInput,
  ProviderUpdate,
  RatesResult,
  Shipment,
  ShipmentFilters,
  ShipmentList,
  ShipmentPipeline,
  ShipmentTransitionInput,
  ShippingProviderConfig,
} from "@/types/shipping";

import { apiGet, apiPost, apiPut, query } from "@/services/api/client";

/**
 * Shipments, couriers and delivery estimates (docs/shipping-and-suppliers.md §6).
 *
 * Every call throws `ApiError` on failure; the screens decide what to say.
 * Every permission is checked on the server.
 */

const CUSTOMER = { auth: "customer" } as const;
const ADMIN = { auth: "admin" } as const;

const enc = encodeURIComponent;

/* ---------------------------------------------------------------- customer */

/** The signed-in customer's shipments for one of their orders, oldest events first. */
export function getOrderShipments(identifier: string): Promise<CustomerShipment[]> {
  return apiGet(`/orders/${enc(identifier)}/shipments`, CUSTOMER);
}

/**
 * When a pincode can expect delivery. Public. Kept short: the answer is a
 * nicety at checkout, never something to wait for.
 */
export function getDeliveryEstimate(
  pincode: string,
  { cod, signal }: { cod?: boolean; signal?: AbortSignal } = {},
): Promise<DeliveryEstimate> {
  return apiGet(`/delivery/estimate${query({ pincode, cod })}`, { signal, timeoutMs: 6_000 });
}

/* -------------------------------------------------------- admin: shipments */

export function listShipments(filters: ShipmentFilters = {}): Promise<ShipmentList> {
  return apiGet(`/admin/shipments${query({ ...filters })}`, ADMIN);
}

export function getShipment(id: string | number): Promise<Shipment> {
  return apiGet(`/admin/shipments/${enc(String(id))}`, ADMIN);
}

export function getOrderShipping(orderId: string): Promise<OrderShipping> {
  return apiGet(`/admin/orders/${enc(orderId)}/shipping`, ADMIN);
}

export function getShippingRates(
  orderId: string,
  input: { providerCode: string; package: Pick<PackageInput, "weightGrams" | "lengthCm" | "widthCm" | "heightCm"> },
): Promise<RatesResult> {
  return apiPost(`/admin/orders/${enc(orderId)}/shipping/rates`, input, ADMIN);
}

export function createShipment(input: CreateShipmentInput): Promise<Shipment> {
  return apiPost("/admin/shipments", input, ADMIN);
}

export function updateShipmentPackage(id: number, pkg: PackageInput): Promise<Shipment> {
  return apiPut(`/admin/shipments/${id}/package`, { package: pkg }, ADMIN);
}

export function generateLabel(id: number): Promise<Shipment> {
  return apiPost(`/admin/shipments/${id}/label`, {}, ADMIN);
}

export function schedulePickup(id: number): Promise<Shipment> {
  return apiPost(`/admin/shipments/${id}/pickup`, {}, ADMIN);
}

export function cancelShipment(id: number, reason: string): Promise<Shipment> {
  return apiPost(`/admin/shipments/${id}/cancel`, { reason }, ADMIN);
}

export function retryShipment(id: number): Promise<Shipment> {
  return apiPost(`/admin/shipments/${id}/retry`, {}, ADMIN);
}

export function refreshShipment(id: number): Promise<Shipment> {
  return apiPost(`/admin/shipments/${id}/refresh`, {}, ADMIN);
}

export function addShipmentEvent(id: number, input: ManualEventInput): Promise<Shipment> {
  return apiPost(`/admin/shipments/${id}/events`, input, ADMIN);
}

/**
 * Move a shipment one step (`shipment.transitions`). The server refuses any
 * other move, and asks for a reason for exceptions and backward moves.
 */
export function moveShipment(id: number, input: ShipmentTransitionInput): Promise<Shipment> {
  return apiPost(`/admin/shipments/${id}/status`, input, ADMIN);
}

/** Packed orders waiting for a shipment, and dispatched orders with none on record. */
export function getShipmentPipeline(): Promise<ShipmentPipeline> {
  return apiGet("/admin/shipments/pipeline", ADMIN);
}

/* -------------------------------------------------------- admin: providers */

export function listShippingProviders(): Promise<ShippingProviderConfig[]> {
  return apiGet("/admin/shipping/providers", ADMIN);
}

export function updateShippingProvider(code: string, patch: ProviderUpdate): Promise<ShippingProviderConfig> {
  return apiPut(`/admin/shipping/providers/${enc(code)}`, patch, ADMIN);
}

/** Tests the saved credentials, with any typed (not yet saved) `credentials` and `environment` used instead. */
export function testShippingProvider(
  code: string,
  draft: { credentials?: Record<string, string>; environment?: string } = {},
): Promise<{ ok: boolean; message: string }> {
  return apiPost(`/admin/shipping/providers/${enc(code)}/test`, draft, ADMIN);
}

/** A key for one create attempt, so a double click or a retry can't create two shipments. */
export function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // not a secure context
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
