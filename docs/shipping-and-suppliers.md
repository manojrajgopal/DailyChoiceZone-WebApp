# Shipping, courier integration, suppliers and purchase orders

This is the design and the API contract for three features:

- order shipment tracking,
- the courier (shipping provider) integration,
- supplier management with purchase orders and goods receiving.

It is the single source of truth that the backend and the frontend are both
built against. Field names below are exactly what the API sends and accepts:
camelCase on the wire, as everywhere else in this project.

All responses use the project envelope: `{ success, data, message }`. Lists
use `{ success, data: { items, pagination } }`, the same as the support and
abandoned-cart lists. Errors use `{ success: false, message, error_code, details? }`.

## 1. How it fits the existing system

| Existing piece | How it is reused |
|---|---|
| `orders.update_status` (order state machine + its emails, COD capture, loyalty, referrals) | A shipment never sets an order's status directly. Courier milestones move the order **forward only**, through `update_status(actor="courier", confirm=True)`. The existing *order shipped / in transit / out for delivery / delivered* emails and every side effect keep working unchanged. |
| `Order.tracking_number`, `Order.expected_delivery` | Kept in step with the active shipment's AWB and expected delivery, so everything that already shows them keeps working. |
| `serviceability` (store-managed pincodes) | Remains the authority at checkout. The courier is consulted only for pincodes the store hasn't listed, and only when the store switches that on. When the courier can't be reached, checkout is never blocked. |
| Delivery charges | **Unchanged.** Customers are charged by the store's own rules (store settings + pincode table). Courier rates are shown to the team when choosing a courier for a shipment; they don't silently change what customers pay. |
| `email/crypto.seal/unseal` | Encrypts courier credentials at rest. |
| `email.notify` + `messaging.catalogue` | New events: `shipment_created`, `delivery_attempted`, `delivery_failed`, `shipment_returned`. Shipped / in-transit / out-for-delivery / delivered reuse the existing order-stage events. |
| `inbox.staff` | Alerts to the team: creation failures, courier unreachable, webhook failures, stuck shipments, pickup failures. |
| `jobs.tracked` + `run_forever` + lifespan | New job `shipping`: retries failed courier operations, refreshes tracking only for shipments that are due, and flags stuck ones. |
| `products` stock ledger (`StockAdjustment`) | Goods receiving adds stock through a new locked increment in the products service, `products.receive_stock`. It writes the same ledger rows (reason `purchase-receipt`) and runs the same status and alert logic as `adjust_stock`. |
| `billing.calculate_tax` | Calculates tax on purchase orders: GST exclusive, intra-state CGST+SGST vs inter-state IGST, from the supplier's state. |
| `core.numbering.Series` | Shipment numbers `DCZ-SH-2026-000001`, PO numbers `DCZ-PO-2026-000001`, goods receipts `DCZ-GRN-2026-000001`. Supplier ids use `utils.ids` (`SUP001`). |
| `audit.record` | Records every admin action on shipments, providers, suppliers, POs and receipts. A supplier's history is its audit trail plus its POs' events. |
| RBAC (`require_access`) | New permissions: `shipments`, `shipping-config` (super admin only), `suppliers`, `purchasing`. |

## 2. Permissions

| Permission | Covers | Roles |
|---|---|---|
| `shipments` | Viewing and operating shipments: create, label, pickup, cancel, refresh, retry, manual events, rates | super-admin, admin, manager, staff |
| `shipping-config` | Courier provider configuration and credentials | super-admin only (like `support-config`) |
| `suppliers` | Supplier directory and supplier–product links | super-admin, admin, manager |
| `purchasing` | Purchase orders and goods receiving | super-admin, admin, manager |

The existing `shipping` permission keeps meaning *pincode serviceability*.
Every check is made on the server.

## 3. Shipping provider architecture

`app/services/shipping/` contains:

- `base.py`: the `ShippingProvider` interface, the result dataclasses, `ProviderError(transient: bool)` and `Unsupported`.
- `registry.py`: `adapter_for(code)` and `active_provider(db, code)`. These build the adapter from the saved configuration and the decrypted credentials.
- `manual.py`: **Manual**. For couriers without an API: staff enter the courier name and AWB, and record each tracking event by hand. No network.
- `shiprocket.py`: **Shiprocket**, at `https://apiv2.shiprocket.in/v1/external`, using bearer-token auth (email + password → token, cached until it expires).
- `providers.py`: saving and reading the courier configuration (credentials sealed, write-only, masked on read).
- `service.py`: shipments: creating, label, pickup, cancel, retry, refresh, manual events, applying courier updates, the admin and customer views.
- `webhooks.py`: verifying, de-duplicating and applying courier webhooks.
- `estimate.py`: the checkout delivery estimate.
- `jobs.py`: the `shipping` background job.

Each operation is a method. A provider that can't do something raises `Unsupported`, and the UI hides that action:

| Method | Shiprocket | Manual |
|---|---|---|
| `test_connection()` | `POST /auth/login` | always OK |
| `services()` | the services configured (e.g. Surface, Express) | configured list |
| `serviceability(pickup_pincode, delivery_pincode, weight_kg, cod)` | `GET /courier/serviceability/` (with `available_courier_companies`: `courier_company_id`, `courier_name`, `rate`, `etd`, `estimated_delivery_days`, `cod`) | Unsupported |
| `create_shipment(request)` | `POST /orders/create/adhoc`, then `POST /courier/assign/awb` (AWB, courier) | uses the AWB the admin typed |
| `generate_label(shipment)` | `POST /courier/generate/label` (→ `label_url`) | Unsupported |
| `schedule_pickup(shipment)` | `POST /courier/generate/pickup` (→ `pickup_scheduled_date`, `pickup_token_number`) | Unsupported |
| `cancel_shipment(shipment)` | `POST /orders/cancel` (`ids`) | local only |
| `track(shipment)` | `GET /courier/track/awb/{awb}` (→ `tracking_data.shipment_track_activities[]`: `date`, `status`, `activity`, `location`, `sr-status-label`) | Unsupported (events are manual) |
| `parse_webhook(headers, body)` | verifies `x-api-key` == configured webhook token, constant-time; reads `awb`, `current_status`, `scans[]` | Unsupported |

**Errors.** A timeout, a connection failure, a 5xx or a 429 is a `ProviderError(transient=True)`, which the job retries with backoff. A 4xx such as invalid credentials, an invalid address or an unserviceable pincode is `transient=False`. That surfaces to the admin with the provider's message, and isn't retried. A malformed answer is a non-transient `ProviderError`. Secrets never appear in error text or logs.

**Status mapping.** Courier status text is normalised to the shipment vocabulary below by keyword rules. Unknown text is still recorded as an event (`status: ""`, raw text kept), but never moves the shipment.

**Adding a courier.** Add one module implementing `ShippingProvider` and one entry in the registry. Nothing else changes.

### Provider configuration (stored per provider code)

Saved in table `shipping_providers`, one row per adapter code:

- `name`, `environment` (`production`/`sandbox`; Shiprocket has production only)
- `active`, `isDefault`
- `settings`:
  - `defaultService`, `services[]`
  - `pickupLocation`: the Shiprocket pickup nickname
  - `origin`: `{ name, phone, line1, line2, city, state, pincode }`
  - `checkoutServiceability` (bool)
  - `defaultPackage`: optional, admin-entered; never invented
- `credentials`: encrypted (`seal`) and write-only
  - Shiprocket: `email`, `password`, `webhookToken`
  - Manual: none

Reading the configuration returns only *which* credential fields are set, each masked as `••••abcd`, never the values.

## 4. Shipment lifecycle

Shipment `status`:

```
pending ─► ready-for-pickup ─► pickup-scheduled ─► picked-up ─► in-transit ─► at-destination-hub ─► out-for-delivery ─► delivered
              (AWB assigned)                                          │                                    │
                                                                      └──► delivery-attempted ◄────────────┘
                                                                           delivery-failed ─► returned-to-origin
cancelled (from pending / ready-for-pickup / pickup-scheduled only)
```

`pending` means the shipment is recorded but not confirmed by the courier yet: creation is in flight, or failed and awaiting a retry. `requestStatus` (`ok` / `pending` / `failed`), `lastError` and `retryCount` explain it.

**What moves the order** (forward only, never backwards, never from a terminal state):

| Shipment status | Order status |
|---|---|
| picked-up | shipped |
| in-transit, at-destination-hub | in-transit |
| out-for-delivery | out-for-delivery |
| delivered | delivered |

`delivery-failed` and `returned-to-origin` don't change the order. They alert the team and the customer, and the team decides: re-ship, or record a return.

**Creating a shipment** is an explicit admin action, never automatic:

- **Allowed** for a `packed` order whose packing job is packed, or to record
  the missing shipment of an order already dispatched without one, or to
  re-ship after a return to origin (docs/order-fulfilment.md).
- **Refused** before packing is complete (`PACKING_INCOMPLETE`), if the payment
  blocks fulfilment, or if the order is cancelled or delivered.
- Manual status moves go one step at a time through
  `POST /api/admin/shipments/{id}/status` (docs/order-fulfilment.md).

**Idempotency.** An order has at most one *active* (non-cancelled) shipment, enforced by a unique `active_key` column (the order id while active, NULL once cancelled; the same pattern as price alerts). Creation also takes a client `idempotencyKey`:

- **The same key again** returns the same shipment; a double click is harmless.
- **A different key** while an active shipment exists → `409 SHIPMENT_EXISTS`.

The shipment row is committed *before* the courier is called. If the call fails or times out, the row stays `pending` with the error, and **Retry** (or the job) continues from where it stopped, without creating a second courier order:

- If `providerShipmentId` is already known, the order step is skipped and only the AWB is assigned.
- A timeout during the order step is retried by looking up the courier order by our reference (the shipment number) before creating it again.

**Events** are deduplicated by `(shipment_id, dedupe_key)`, a unique index. The key is the provider event id when there is one, otherwise a hash of time + status + location. Webhook deliveries are deduplicated by `(provider, event_key)`.

## 5. Database (migration `20261006_0900_shipping_suppliers`)

All money in **paise** (BIGINT, `Money` type) in the database. **Rupees** on the API, as product prices are.

- `shipping_providers`:
  - `id` PK, `code` UNIQUE, `name`, `environment`
  - `active`, `is_default`
  - `credentials` (TEXT, sealed), `settings` (JSON)
  - `last_tested_at`, `last_test_ok`, `last_error`, `created_at`, `updated_at`
- `shipments`:
  - Identity:
    - `id` PK, `shipment_number` UNIQUE
    - `order_id` FK→orders RESTRICT, `provider_id` FK→shipping_providers RESTRICT, `provider_code`
    - `active_key` UNIQUE NULL, `idempotency_key` UNIQUE NULL
  - Courier:
    - `courier_name`, `courier_code`, `service`
    - `provider_order_id`, `provider_shipment_id` (UNIQUE with provider_id)
    - `awb` (UNIQUE with provider_id), `status`
  - Package:
    - `weight_grams`, `length_cm`, `width_cm`, `height_cm`
    - `package_count`, `package_type`
    - `cod`, `cod_amount`, `declared_value`
  - Route: `origin` JSON, `destination` JSON, `expected_delivery_at`
  - Label and pickup: `label_url`, `pickup_status`, `pickup_scheduled_at`, `pickup_token`
  - Provider sync:
    - `request_status`, `last_operation`, `last_error`, `last_error_at`
    - `retry_count`, `next_retry_at`
    - `last_synced_at`, `next_sync_at`, `last_webhook_at`
  - Lifecycle: `delivered_at`, `cancelled_at`, `cancel_reason`, `created_by`, `created_at`, `updated_at`
- `shipment_events`:
  - `id` PK, `shipment_id` FK CASCADE
  - `status`, `provider_status`, `description`, `location`
  - `occurred_at`, `received_at`
  - `source` (`webhook`/`poll`/`admin`/`system`), `actor`, `visible`
  - `dedupe_key`, UNIQUE(`shipment_id`, `dedupe_key`)
- `shipping_webhook_events`:
  - `id` PK, `provider_code`, `event_key`, UNIQUE(provider_code, event_key)
  - `shipment_id` FK SET NULL, `status`, `attempts`, `last_error`
  - `payload` JSON: courier fields only, no customer contact details
  - `received_at`, `processed_at`
- `suppliers`:
  - Identity: `id` PK (`SUP001`), `code` UNIQUE, `name`, `legal_name`, `status` (active/inactive/archived)
  - Contact: `contact_person`, `phone`, `email`, `website`
  - Tax: `gstin` NULL, `pan` NULL, `business_type`, `tax_treatment`
  - Addresses: `billing_address` JSON, `warehouse_address` JSON
  - Terms: `payment_terms`, `credit_days`, `currency`, `notes`
  - `created_by`, `created_at`, `updated_at`
- `supplier_products`:
  - `id` PK, `supplier_id` FK CASCADE, `product_id` FK CASCADE, UNIQUE(supplier, product)
  - `supplier_sku`, `purchase_cost` (paise), `moq`, `lead_time_days`
  - `status`, `preferred`, `notes`, `created_at`, `updated_at`
- `purchase_orders`:
  - Identity: `id` PK (`POR001`), `po_number` UNIQUE, `supplier_id` FK RESTRICT, `status`
  - Money:
    - `currency`, `tax_mode`
    - `subtotal`, `cgst`, `sgst`, `igst`, `tax_total`, `total`
  - `expected_at`, `supplier_reference`, `notes`
  - `submitted_at`, `sent_at`, `acknowledged_at`, `received_at`, `cancelled_at`, `cancel_reason`
  - `created_by`, `created_at`, `updated_at`
- `purchase_order_items`:
  - `id` PK, `purchase_order_id` FK CASCADE, `product_id` FK RESTRICT, UNIQUE(po, product)
  - `name`, `sku`, `quantity`, `unit_cost`, `tax_rate`
  - `line_subtotal`, `line_tax`, `line_total`
  - `received_qty`, `damaged_qty`, `rejected_qty`
- `purchase_order_events`: `id`, `purchase_order_id` FK CASCADE, `status`, `note`, `actor`, `occurred_at`
- `goods_receipts`:
  - `id` PK, `receipt_number` UNIQUE, `purchase_order_id` FK RESTRICT
  - `received_at`, `notes`, `idempotency_key` UNIQUE NULL
  - `over_receipt_reason`, `created_by`, `created_at`
- `goods_receipt_items`:
  - `id`, `receipt_id` FK CASCADE, `purchase_order_item_id` FK RESTRICT, `product_id`
  - `received_qty`, `damaged_qty`, `rejected_qty`, `accepted_qty`, `note`

## 6. API contract

### Customer

`GET /api/orders/{identifier}/shipments`: the signed-in customer's own order only; 404 otherwise.

```json
[{
  "shipmentNumber": "DCZ-SH-2026-000001",
  "status": "in-transit", "statusLabel": "In transit",
  "courierName": "Delhivery Surface", "service": "Surface", "awb": "1234567890",
  "trackingUrl": "",                 // a courier page link when the provider gives one
  "expectedDeliveryAt": "2026-10-09T00:00:00", "deliveredAt": null,
  "createdAt": "...",
  "events": [ { "status": "picked-up", "label": "Picked up", "description": "Shipment picked up",
                "location": "Bengaluru Hub", "occurredAt": "...", "source": "courier" } ]
}]
```

Events are oldest first, customer-visible only. `source` is `courier` or `store`; nothing internal is exposed (no errors, retries, provider ids or notes). Cancelled shipments are included with status `cancelled`, so the history stays honest.

`GET /api/delivery/estimate?pincode=560001&cod=false` (public, rate-limited):

```json
{ "pincode": "560001", "source": "store" | "courier" | "none",
  "serviceable": true | false | null,      // null = couldn't tell (courier unreachable)
  "codAvailable": true | false | null, "etaDays": { "min": 2, "max": 4 } | null,
  "label": "Delivery by Thu, 9 Oct" | "", "message": "" }
```

The store's pincode table wins when it lists the pincode. The courier is asked only when the store hasn't listed it and the **default** courier has `checkoutServiceability` on and an origin pincode, with a 4-second timeout and a 6-hour cache per pincode. Any courier failure gives `source: "none", serviceable: null` (remembered for 5 minutes), and checkout carries on as today. The weight asked about is the default package's, or a nominal 500 g when none is set; this only affects the estimate, never a shipment. The label uses the cheapest courier's estimate, since that is the one usually booked.

### Admin: shipments (`shipments`)

Shipment object (admin):

```json
{
  "id": 12, "shipmentNumber": "DCZ-SH-2026-000012", "status": "ready-for-pickup", "statusLabel": "Ready for pickup",
  "order": { "id": "ORD042", "orderNumber": "DCZ10042", "status": "packed", "paymentStatus": "paid",
             "paymentMethod": "upi", "total": 2498.0, "placedAt": "...",
             "customer": { "id": "CUS001", "name": "Asha Rao", "email": "a@b.co", "phone": "98..." },
             "items": [ { "productId": "PRD001", "name": "Cotton Kurta", "sku": "DCZ-WO0001", "quantity": 2,
                          "size": "M", "color": "Red", "lineTotal": 2000.0 } ] },
  "provider": { "code": "shiprocket", "name": "Shiprocket" },
  "courierName": "Delhivery Surface", "courierCode": "12", "service": "Surface",
  "awb": "1234567890", "providerShipmentId": "98765", "providerOrderId": "55555",
  "package": { "weightGrams": 800, "lengthCm": 30, "widthCm": 20, "heightCm": 5, "count": 1, "type": "box" },
  "cod": false, "codAmount": 0, "declaredValue": 2498.0,
  "origin": { "name": "...", "line1": "...", "city": "...", "state": "...", "pincode": "..." },
  "destination": { "name": "...", "phone": "...", "line1": "...", "line2": "", "city": "...", "state": "...", "pincode": "..." },
  "expectedDeliveryAt": null, "deliveredAt": null,
  "label": { "available": true, "url": "https://..." },
  "pickup": { "status": "scheduled" | "" | "failed", "scheduledAt": "...", "token": "..." },
  "events": [ { "id": 1, "status": "...", "label": "...", "providerStatus": "PICKED UP", "description": "...",
                "location": "...", "occurredAt": "...", "receivedAt": "...", "source": "webhook|poll|admin|system",
                "actor": "ADM001", "visible": true } ],
  "technical": { "requestStatus": "ok|pending|failed", "lastOperation": "create", "lastError": "",
                 "lastErrorAt": null, "retryCount": 0, "nextRetryAt": null,
                 "lastSyncedAt": null, "lastWebhookAt": null },
  "actions": { "label": true, "pickup": true, "cancel": true, "refresh": true, "retry": false,
               "manualEvent": true, "editPackage": false },
  "createdAt": "...", "updatedAt": "...", "createdBy": "ADM001"
}
```

`actions` is computed on the server from the status and what the provider supports, and the UI shows only those buttons.

- `GET /api/admin/shipments?q=&status=&courier=&provider=&from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&pageSize=25`
  - `q` matches shipment number, order number, AWB, or customer name/email.
  - Returns `{ items: [ {id, shipmentNumber, status, statusLabel, orderId, orderNumber, customerName, courierName, awb, providerCode, requestStatus, lastError, expectedDeliveryAt, createdAt, updatedAt} ], pagination }` plus `counts: {status: n}`.
- `GET /api/admin/shipments/{id}` returns the shipment object.
- `GET /api/admin/orders/{orderId}/shipping`:
  - `{ order: {...same as shipment.order}, destination, shipments: [summary...], activeShipmentId, canCreate, reason, providers: [ {code, name, isDefault, services: [..], supports: {rates, label, pickup, tracking, cancel, manualAwb}} ], defaultPackage: {...} | null }`
  - `reason` explains a `canCreate: false`.
- `POST /api/admin/orders/{orderId}/shipping/rates` with `{ providerCode, package: {weightGrams, lengthCm, widthCm, heightCm} }`:
  - Returns `{ options: [ {courierCode, courierName, rate, etaDays, estimatedDeliveryAt, codAvailable} ], source }`.
  - Errors: 422 `PACKAGE_REQUIRED`, 503 `COURIER_UNAVAILABLE`, 400 `UNSUPPORTED`.
- `POST /api/admin/shipments` with `{ orderId, providerCode, service, courierCode?, courierName? (manual), awb? (manual), package: {weightGrams, lengthCm, widthCm, heightCm, count, type}, idempotencyKey }` → 201 shipment object.
  - Package fields are required for API providers; Manual needs only weight.
  - Errors: 404 `ORDER_NOT_FOUND`; 409 `SHIPMENT_EXISTS` / `ORDER_NOT_SHIPPABLE` / `AWAITING_PAYMENT`; 422 validation; 400 `PROVIDER_INACTIVE`.
  - If the courier call fails, the answer is still 201 with `technical.requestStatus = "failed"` and `lastError`. The record exists and can be retried.
- `PUT /api/admin/shipments/{id}/package` with `{package}`. Only while `pending` (not yet confirmed by the courier).
- `POST /api/admin/shipments/{id}/label` returns the shipment, with `label.url`.
- `POST /api/admin/shipments/{id}/pickup` returns the shipment.
- `POST /api/admin/shipments/{id}/cancel` with `{ reason }` returns the shipment.
  - Refused after pickup: 409 `SHIPMENT_NOT_CANCELLABLE`.
- `POST /api/admin/shipments/{id}/retry` retries the last failed operation and returns the shipment.
  - 409 `NOTHING_TO_RETRY`.
- `POST /api/admin/shipments/{id}/refresh` pulls tracking now and returns the shipment.
  - Rate-limited per shipment; 400 `UNSUPPORTED` for Manual.
- `POST /api/admin/shipments/{id}/events` with `{ status, description, location, occurredAt, visible }` → 201 the shipment.
  - A manual event, recorded with `source: "admin"`; it moves the shipment and order like a courier event would.
  - Refused for an unknown status or a move backwards from a terminal state.

### Admin: providers (`shipping-config`; the list is also readable with `shipments`, but without credentials)

- `GET /api/admin/shipping/providers`:
  - `[ { code, name, available: true, description, environment, environments: ["production"], active, isDefault, settings: {...}, credentialFields: [ {key, label, secret: true} ], credentials: { email: "a••••@x.com", password: "••••••••", webhookToken: "••••abcd" }, configured: bool, webhookUrl: "https://<api>/api/shipping/webhooks/shiprocket", lastTestedAt, lastTestOk, lastError, supports: {...} } ]`
  - Every available adapter is listed, configured or not.
- `PUT /api/admin/shipping/providers/{code}` with `{ name?, environment?, active?, isDefault?, settings?, credentials?: { key: value } }`.
  - A blank or omitted credential keeps the stored value; credentials are write-only.
  - Activating requires the required credentials to be set.
  - Exactly one provider is default.
- `POST /api/admin/shipping/providers/{code}/test` returns `{ ok, message }` and records `lastTestedAt` / `lastTestOk` / `lastError`.

### Courier webhooks (public)

`POST /api/shipping/webhooks/{code}`. Shiprocket sends header `x-api-key`, which must equal the configured `webhookToken`.

| Case | Response |
|---|---|
| Wrong or missing token | 401 (nothing is processed) |
| Body not JSON | 400 |
| Unknown AWB | 200 and recorded `ignored` (so the courier doesn't retry forever) |
| Duplicate delivery | 200 `duplicate` |
| Processing error | 500, and recorded `failed` so a resend is safe |
| Body over 256 KB | 413 |

### Admin: suppliers (`suppliers`)

Supplier object:

```json
{ "id": "SUP001", "code": "ANVI-TEX", "name": "Anvi Textiles", "legalName": "Anvi Textiles Pvt Ltd",
  "contactPerson": "R. Kumar", "phone": "9876543210", "email": "sales@anvi.example", "website": "https://anvi.example",
  "status": "active", "gstin": "29ABCDE1234F1Z5" | null, "pan": "ABCDE1234F" | null, "businessType": "manufacturer",
  "taxTreatment": "registered" | "unregistered" | "composition" | "overseas",
  "billingAddress": { "line1": "", "line2": "", "city": "", "state": "", "country": "India", "pincode": "" },
  "warehouseAddress": { ...same } | null,
  "paymentTerms": "Net 30", "creditDays": 30, "currency": "INR", "notes": "",
  "createdAt": "...", "updatedAt": "...", "createdBy": "ADM001" }
```

Validation:

- `code` is uppercase letters, digits and hyphens, 2–30 characters, unique (409 `SUPPLIER_CODE_TAKEN`).
- `name` is required.
- `gstin` is optional, but if given must match the 15-character GSTIN format with a valid checksum, and is required when `taxTreatment` is `registered`.
- `pan` is optional; if given it must match `^[A-Z]{5}[0-9]{4}[A-Z]$`, and must agree with GSTIN characters 3–12 when both are given.
- `email` and `phone` (Indian 10-digit, or + international) are checked if given.
- `creditDays` is 0–365.
- The billing `pincode` is 6 digits when the country is India.

Endpoints:

- `GET /api/admin/suppliers?q=&status=&page=&pageSize=&sort=name|code|createdAt`
  - Returns `{items, pagination, counts}`. `status` defaults to everything but archived; `status=archived` shows those.
- `POST /api/admin/suppliers` → 201 supplier.
  - When `code` is omitted it is generated from the id.
- `GET /api/admin/suppliers/{id}` returns the supplier plus:
  - `stats`:
    - `{ productCount, activeProductCount, poCount, openPoCount, receivedPoCount, totalPurchaseValue, outstandingQuantity }`
    - `averageLeadTimeDays` (null unless at least 3 fully received POs)
    - `onTimeRate` (null unless at least 3 received POs with an expected date)
  - `recentDeliveries`: the last 5 receipts.
  - `history`: the last 50 audit and PO events, as `{at, action, summary, actor}`.
- `PUT /api/admin/suppliers/{id}` returns the supplier.
- `POST /api/admin/suppliers/{id}/status` with `{ status: "active"|"inactive"|"archived" }`.
  - Archiving is refused while the supplier has an open PO: 409 `SUPPLIER_HAS_OPEN_POS`.
- `GET /api/admin/suppliers/{id}/products` returns `[supplierProduct]`.
- `POST /api/admin/suppliers/{id}/products` with `{ productId, supplierSku, purchaseCost, moq, leadTimeDays, status, preferred, notes }` → 201.
  - `purchaseCost` is in rupees, > 0 and ≤ 10,000,000.
  - `moq` is ≥ 1.
  - `leadTimeDays` is 0–365 or null.
  - Errors: 409 `SUPPLIER_PRODUCT_EXISTS`; 404 `PRODUCT_NOT_FOUND` (archived products can't be linked: 422 `PRODUCT_ARCHIVED`); 409 `SUPPLIER_INACTIVE` for an archived supplier.
  - Marking one link `preferred` clears that flag on the product's other links.
- `PUT /api/admin/supplier-products/{id}` and `DELETE /api/admin/supplier-products/{id}`.
- `GET /api/admin/products/{productId}/suppliers` returns `[supplierProduct]` for the product page.

supplierProduct:

```json
{ "id": 3, "supplierId": "SUP001", "supplierName": "Anvi Textiles", "supplierStatus": "active",
  "productId": "PRD001", "productName": "Cotton Kurta", "productSku": "DCZ-WO0001", "productStatus": "active",
  "supplierSku": "AT-K-01", "purchaseCost": 450.0, "moq": 10, "leadTimeDays": 7,
  "status": "active", "preferred": true, "notes": "", "createdAt": "...", "updatedAt": "..." }
```

### Admin: purchase orders (`purchasing`)

Status flow:

```
draft ─► submitted ─► sent ─► acknowledged ─► partially-received ─► received
  └────────┴──────────┴──────────┴─► cancelled   (only before anything has been received)
```

- `sent → partially-received` is also allowed: the supplier may never acknowledge.
- Receiving is allowed from `sent`, `acknowledged` and `partially-received`.

PO object:

```json
{ "id": "POR001", "poNumber": "DCZ-PO-2026-000001", "status": "draft", "statusLabel": "Draft",
  "supplier": { "id": "SUP001", "code": "ANVI-TEX", "name": "Anvi Textiles", "status": "active", "state": "Karnataka" },
  "currency": "INR", "taxMode": "intra-state" | "inter-state",
  "items": [ { "id": 1, "productId": "PRD001", "name": "Cotton Kurta", "sku": "DCZ-WO0001", "supplierSku": "AT-K-01",
               "quantity": 50, "unitCost": 450.0, "taxRate": 5.0, "lineSubtotal": 22500.0, "lineTax": 1125.0,
               "lineTotal": 23625.0, "receivedQty": 0, "damagedQty": 0, "rejectedQty": 0,
               "acceptedQty": 0, "outstandingQty": 50 } ],
  "subtotal": 22500.0, "cgst": 562.5, "sgst": 562.5, "igst": 0, "taxTotal": 1125.0, "total": 23625.0,
  "expectedAt": "2026-10-15" | null, "supplierReference": "", "notes": "",
  "timeline": [ { "status": "draft", "note": "", "actor": "ADM001", "at": "..." } ],
  "receipts": [ { "id": 1, "receiptNumber": "DCZ-GRN-2026-000001", "receivedAt": "...", "notes": "",
                  "createdBy": "ADM001", "items": [ { "poItemId": 1, "productId": "PRD001", "name": "...",
                  "receivedQty": 20, "damagedQty": 1, "rejectedQty": 0, "acceptedQty": 19, "note": "" } ] } ],
  "actions": { "edit": true, "submit": true, "send": false, "acknowledge": false, "receive": false, "cancel": true },
  "createdAt": "...", "updatedAt": "...", "createdBy": "ADM001" }
```

Tax:

- Each line: `lineSubtotal = quantity × unitCost`.
- `taxRate` defaults to the product's `taxRatePercent`, or the tax settings' category rate.
- Prices are exclusive of tax.
- Intra-state, where the supplier's billing state equals the store's origin state, splits into CGST/SGST; otherwise IGST.
- An `unregistered`/`overseas` supplier gets no GST. Totals are computed on the server.

Endpoints:

- `GET /api/admin/purchase-orders?q=&status=&supplier=&from=&to=&page=&pageSize=` returns `{items: [ {id, poNumber, status, statusLabel, supplierId, supplierName, itemCount, total, expectedAt, createdAt} ], pagination, counts}`.
- `POST /api/admin/purchase-orders` with `{ supplierId, items: [{productId, quantity, unitCost?, taxRate?}], expectedAt?, supplierReference?, notes? }` → 201 draft.
  - `unitCost` defaults to the supplier–product purchase cost (422 `UNIT_COST_REQUIRED` if neither).
  - `quantity` is 1–1,000,000 and below the MOQ only with a warning in the response (`warnings: []`).
  - Products must not be archived.
  - Errors: 409 `SUPPLIER_INACTIVE` (inactive or archived); 422 `NO_ITEMS` / `DUPLICATE_ITEM`.
- `GET /api/admin/purchase-orders/{id}`
- `PUT /api/admin/purchase-orders/{id}`: same body, draft only (409 `PO_NOT_EDITABLE`).
- `POST /api/admin/purchase-orders/{id}/submit` | `/send` | `/acknowledge`, all with `{ note? }`.
  - 409 `INVALID_PO_TRANSITION`.
- `POST /api/admin/purchase-orders/{id}/cancel` with `{ reason }` (required).
  - 409 if anything has been received.
- `POST /api/admin/purchase-orders/{id}/receipts` with `{ receivedAt?: "YYYY-MM-DD", notes?, idempotencyKey, items: [ {poItemId, receivedQty, damagedQty, rejectedQty, note?} ], allowOverReceipt?: false, overReceiptReason? }` → 201 PO.
  - `acceptedQty = receivedQty − damagedQty − rejectedQty`, which is added to stock through `products.receive_stock`. The ledger reason is `purchase-receipt`, and the note names the PO and the receipt.
  - Validation:
    - damaged + rejected ≤ received;
    - all quantities ≥ 0;
    - at least one line > 0;
    - received ≤ outstanding unless `allowOverReceipt` with a reason (422 `OVER_RECEIPT`);
    - `receivedAt` not in the future.
  - The same `idempotencyKey` again returns the PO unchanged, so stock isn't added twice.
  - The status becomes `partially-received` or `received`.
  - Receiving into an archived product is refused (422 `PRODUCT_ARCHIVED`).
- `GET /api/admin/purchase-orders/{id}/receipts`

### Frontend routes

Static-export friendly: detail pages take `?id=`, as the rest of the portal does.

| Page | Route |
|---|---|
| Shipments list | `/admin/shipments` |
| Shipment detail (timeline, technical panel, actions) | `/admin/shipments/detail?id=12` |
| Create shipment | from the admin order detail page (`/admin/orders/detail?id=`): a "Shipping" card that opens the create dialog |
| Courier settings | `/admin/settings/couriers` |
| Suppliers list | `/admin/suppliers` |
| New supplier / edit | `/admin/suppliers/new`, `/admin/suppliers/edit?id=SUP001` |
| Supplier detail (stats, products, POs, history) | `/admin/suppliers/detail?id=SUP001` |
| Purchase orders list | `/admin/purchase-orders` |
| New PO | `/admin/purchase-orders/new?supplier=SUP001` (supplier optional) |
| PO detail + receiving | `/admin/purchase-orders/detail?id=POR001` (receiving opens in a dialog on that page) |
| Product's suppliers | a "Suppliers" panel on the product edit page |
| Customer tracking | the customer's order page `/account/order?number=` gains a "Shipment" section |
| Checkout estimate | the delivery-address step shows `/delivery/estimate` when a pincode is entered (never blocks) |

Sidebar entries (`shipments`, `suppliers`, `purchase-orders`, `couriers`) come from the backend's `ADDED_NAV_ITEMS`. Their icons (`shipments`, `suppliers`, `purchaseOrders`) are in `AdminIcons.tsx`.

## 7. Notifications

| Event | Email type | When |
|---|---|---|
| `shipment_created` (new) | order_updates | AWB assigned (tracking number in the email) |
| order_shipped / in_transit / out_for_delivery / delivered | order_updates | existing, via `update_status` |
| `delivery_attempted` (new) | order_updates | courier reports an attempt |
| `delivery_failed` (new) | order_updates | courier reports failure |
| `shipment_returned` (new) | order_updates | returned to origin |

Staff alerts (`inbox.staff`, permission `shipments`):

- shipment creation failed (non-transient, or still failing after 5 retries);
- courier unreachable (≥ 5 consecutive failures);
- webhook processing failed;
- shipment stuck (no update in 5 days while in transit);
- pickup failed.

Each alert fires once per shipment per kind.

## 8. Background job `shipping` (every 5 minutes)

1. **Retry** shipments whose `request_status = failed`, transient, and `next_retry_at <= now`. Backoff is 2, 4, 8, 16 then 32 minutes; it stops after 6 attempts and alerts.
2. **Refresh tracking** only for shipments that are active (not delivered, cancelled or returned), have an AWB, and are due (`next_sync_at <= now`). Each refresh sets `next_sync_at`:
   - 6 h normally;
   - 2 h when out for delivery;
   - 12 h when a webhook arrived in the last 24 h, since webhooks are the primary channel.
   - At most 50 shipments per pass.
3. **Flag stuck** shipments: in transit with no event for 5 days, alerted once.

Manual shipments are never polled.

## 9. Configuration

Everything about couriers is configured in **Admin → Settings → Shipping** and stored encrypted. No courier credentials go in `.env`.

Optional `.env` entries:

- `SHIPPING_HTTP_TIMEOUT_SECONDS=15`
- `SHIPROCKET_BASE_URL=https://apiv2.shiprocket.in/v1/external`: override only for a proxy.

`PUBLIC_API_URL` (existing) forms the webhook URL shown in the portal.

## 10. Setting up a courier

### Shiprocket

1. In Shiprocket, go to **Settings → API → Configure** and create an **API user**: a separate login used only by this integration, not your own account. Note its email and password.
2. In **Settings → Pickup Addresses**, make sure your warehouse exists. Note its **nickname**: that's the *pickup location* the API asks for.
3. In this store's admin portal, open **Settings → Couriers → Shiprocket** and fill in:
   - the API user's email and password;
   - a **webhook token**: any long random string you make up;
   - the pickup location nickname;
   - the origin address (it must match the Shiprocket pickup address);
   - the services you offer (for example Surface, Express) and a default.
4. **Test connection.** It signs in to Shiprocket and reports the result.
5. Switch it **Active**, and make it the **Default** if it's your main courier.
6. In Shiprocket, go to **Settings → API → Webhooks**:
   - Add the **webhook URL** shown on the portal page: `https://<your API>/api/shipping/webhooks/shiprocket`.
   - Paste the same webhook token as the **security token**. Shiprocket sends it as `x-api-key`.
   - Enable it.

   The URL must be HTTPS and reachable from the internet. Locally, use a tunnel (for example ngrok) and set `PUBLIC_API_URL` to it.

Credentials are stored encrypted with the store's key (`EMAIL_ENCRYPTION_KEY`, or `JWT_SECRET_KEY` when that is empty). Changing that key makes them unreadable, and the portal asks for them again. They are never shown after saving; leave a field blank to keep the stored value.

Shiprocket has no sandbox. A test shipment is a real booking: use **Cancel** before pickup.

### Manual

For a courier without an API, or a local delivery partner:

1. Activate **Manual**; it needs no credentials.
2. When creating the shipment, enter the courier's name and the AWB from their receipt.
3. Record each tracking update with **Add event**. Each one moves the shipment, and the order, exactly as a courier update would.

### Adding another courier

Add one module in `backend/app/services/shipping/` implementing `ShippingProvider` (see `base.py`), and register it in `registry.py`:

- Implement only what the courier supports. Everything else raises `Unsupported`, and the portal hides that button.
- Map the courier's status text to the shipment vocabulary in the adapter.
- Raise `ProviderError(transient=...)`: `True` for timeouts and 5xx, `False` for bad requests.

## 11. Testing

```bash
cd backend
# Shipping, suppliers and purchase orders
# (test_api, test_webhooks, test_jobs (job + delivery estimate); unit: test_shipping_rules)
TEST_DATABASE_NAME=dcz_test_ship pytest tests/integration/test_shipping_*.py tests/unit/test_shipping_*.py
# (suppliers, supplier products, purchase orders, receiving; unit: GSTIN/PAN/validation)
TEST_DATABASE_NAME=dcz_test_supp pytest tests/integration/test_suppliers_*.py tests/integration/test_purchase_orders_*.py tests/unit/test_supplier_validation.py
# The migrations still build exactly the models' schema
pytest tests/integration/test_migrations.py

cd ../frontend
npx vitest run src/components/admin/views/shipping src/components/admin/views/suppliers src/components/account src/components/checkout
npx tsc --noEmit
```

Nothing reaches a courier during tests. The HTTP layer is stubbed, but token and signature checks are real, and the suite's network guard fails any test that tries to leave the machine.
