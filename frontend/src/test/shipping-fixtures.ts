/**
 * Shipping fixtures, shaped exactly like docs/shipping-and-suppliers.md §6.
 */
import type {
  CustomerShipment,
  OrderShipping,
  Shipment,
  ShipmentEvent,
  ShipmentSummary,
  ShippingProviderConfig,
} from "@/types/shipping";

export function shipmentEvent(overrides: Partial<ShipmentEvent> = {}): ShipmentEvent {
  return {
    id: 1,
    status: "picked-up",
    label: "Picked up",
    providerStatus: "PICKED UP",
    description: "Shipment picked up",
    location: "Bengaluru Hub",
    occurredAt: "2026-10-03T06:00:00",
    receivedAt: "2026-10-03T06:01:00",
    source: "webhook",
    actor: "",
    visible: true,
    ...overrides,
  };
}

export function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: 12,
    shipmentNumber: "DCZ-SH-2026-000012",
    status: "ready-for-pickup",
    statusLabel: "Ready for pickup",
    order: {
      id: "ORD042",
      orderNumber: "DCZ10042",
      status: "packed",
      paymentStatus: "paid",
      paymentMethod: "upi",
      total: 2498,
      placedAt: "2026-10-01T05:00:00",
      customer: { id: "CUS001", name: "Asha Rao", email: "a@b.co", phone: "9876543210" },
      items: [
        { productId: "PRD001", name: "Cotton Kurta", sku: "DCZ-WO0001", quantity: 2, size: "M", color: "Red", lineTotal: 2000 },
      ],
    },
    provider: { code: "shiprocket", name: "Shiprocket" },
    courierName: "Delhivery Surface",
    courierCode: "12",
    service: "Surface",
    awb: "1234567890",
    providerShipmentId: "98765",
    providerOrderId: "55555",
    package: { weightGrams: 800, lengthCm: 30, widthCm: 20, heightCm: 5, count: 1, type: "box" },
    cod: false,
    codAmount: 0,
    declaredValue: 2498,
    origin: { name: "DCZ Warehouse", line1: "12 Mill Road", city: "Bengaluru", state: "Karnataka", pincode: "560001" },
    destination: {
      name: "Asha Rao",
      phone: "9876543210",
      line1: "4 Lake View",
      line2: "",
      city: "Mysuru",
      state: "Karnataka",
      pincode: "570001",
    },
    expectedDeliveryAt: "2026-10-09T00:00:00",
    deliveredAt: null,
    label: { available: true, url: "https://labels.example/12.pdf" },
    pickup: { status: "", scheduledAt: null, token: "" },
    events: [shipmentEvent()],
    technical: {
      requestStatus: "ok",
      lastOperation: "create",
      lastError: "",
      lastErrorAt: null,
      retryCount: 0,
      nextRetryAt: null,
      lastSyncedAt: "2026-10-03T07:00:00",
      lastWebhookAt: null,
    },
    actions: { label: true, pickup: true, cancel: true, refresh: true, retry: false, manualEvent: true, editPackage: false },
    createdAt: "2026-10-02T05:00:00",
    updatedAt: "2026-10-03T07:00:00",
    createdBy: "ADM001",
    ...overrides,
  };
}

export function shipmentRow(overrides: Partial<ShipmentSummary> = {}): ShipmentSummary {
  return {
    id: 12,
    shipmentNumber: "DCZ-SH-2026-000012",
    status: "in-transit",
    statusLabel: "In transit",
    orderId: "ORD042",
    orderNumber: "DCZ10042",
    customerName: "Asha Rao",
    courierName: "Delhivery Surface",
    awb: "1234567890",
    providerCode: "shiprocket",
    requestStatus: "ok",
    lastError: "",
    expectedDeliveryAt: "2026-10-09T00:00:00",
    createdAt: "2026-10-02T05:00:00",
    updatedAt: "2026-10-03T07:00:00",
    ...overrides,
  };
}

export function orderShipping(overrides: Partial<OrderShipping> = {}): OrderShipping {
  const base = shipment();
  return {
    order: base.order,
    destination: base.destination,
    shipments: [],
    activeShipmentId: null,
    canCreate: true,
    reason: "",
    providers: [
      {
        code: "shiprocket",
        name: "Shiprocket",
        isDefault: true,
        services: ["Surface", "Express"],
        supports: { rates: true, label: true, pickup: true, tracking: true, cancel: true, manualAwb: false },
      },
      {
        code: "manual",
        name: "Manual",
        isDefault: false,
        services: ["Standard"],
        supports: { rates: false, label: false, pickup: false, tracking: false, cancel: true, manualAwb: true },
      },
    ],
    defaultPackage: null,
    ...overrides,
  };
}

export function customerShipment(overrides: Partial<CustomerShipment> = {}): CustomerShipment {
  return {
    shipmentNumber: "DCZ-SH-2026-000001",
    status: "in-transit",
    statusLabel: "In transit",
    courierName: "Delhivery Surface",
    service: "Surface",
    awb: "1234567890",
    trackingUrl: "",
    expectedDeliveryAt: "2026-10-09T00:00:00",
    deliveredAt: null,
    createdAt: "2026-10-02T05:00:00",
    events: [
      { status: "picked-up", label: "Picked up", description: "Shipment picked up", location: "Bengaluru Hub", occurredAt: "2026-10-03T06:00:00", source: "courier" },
      { status: "in-transit", label: "In transit", description: "Left the hub", location: "Hosur", occurredAt: "2026-10-04T06:00:00", source: "courier" },
    ],
    ...overrides,
  };
}

export function providerConfig(overrides: Partial<ShippingProviderConfig> = {}): ShippingProviderConfig {
  return {
    code: "shiprocket",
    name: "Shiprocket",
    available: true,
    description: "Book couriers through Shiprocket.",
    environment: "production",
    environments: ["production"],
    active: true,
    isDefault: true,
    settings: {
      defaultService: "Surface",
      services: ["Surface", "Express"],
      pickupLocation: "Primary",
      origin: { name: "DCZ Warehouse", phone: "9876543210", line1: "12 Mill Road", line2: "", city: "Bengaluru", state: "Karnataka", pincode: "560001" },
      checkoutServiceability: false,
      defaultPackage: null,
    },
    credentialFields: [
      { key: "email", label: "API user email", secret: true },
      { key: "password", label: "API user password", secret: true },
      { key: "webhookToken", label: "Webhook token", secret: true },
    ],
    credentials: { email: "a••••@x.com", password: "••••••••", webhookToken: "••••abcd" },
    configured: true,
    webhookUrl: "https://api.example/api/shipping/webhooks/shiprocket",
    lastTestedAt: "2026-10-01T05:00:00",
    lastTestOk: true,
    lastError: "",
    supports: { rates: true, label: true, pickup: true, tracking: true, cancel: true, manualAwb: false },
    ...overrides,
  };
}

export function manualProvider(overrides: Partial<ShippingProviderConfig> = {}): ShippingProviderConfig {
  return providerConfig({
    code: "manual",
    name: "Manual",
    description: "Couriers without an API.",
    isDefault: false,
    settings: {
      defaultService: "Standard",
      services: ["Standard"],
      origin: { name: "", phone: "", line1: "", line2: "", city: "", state: "", pincode: "" },
      checkoutServiceability: false,
      defaultPackage: null,
    },
    credentialFields: [],
    credentials: {},
    webhookUrl: "",
    lastTestedAt: null,
    lastTestOk: null,
    supports: { rates: false, label: false, pickup: false, tracking: false, cancel: true, manualAwb: true },
    ...overrides,
  });
}
