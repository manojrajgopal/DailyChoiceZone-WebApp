# Order fulfilment: order → packing → shipment → delivery

Every order follows one lifecycle, enforced by the server. No order can skip
packing, be shipped without a shipment, or move backwards without a reason.

- Rules: `backend/app/services/fulfilment/workflow.py`, the one place that
  defines every allowed transition. It imports no other service, so every
  service uses it.
- Order page view and actions: `backend/app/services/fulfilment/overview.py`.
- Portal: `frontend/src/components/admin/views/fulfilment/`, with the service
  in `services/admin/fulfilmentAdminService.ts` and the types in
  `types/fulfilment.ts`.

Related: [packing-and-labels.md](packing-and-labels.md) (the packing job) and
[shipping-and-suppliers.md](shipping-and-suppliers.md) (shipments and
couriers).

## Three records, three status fields

These are separate on purpose. Each page filters on its own record's status,
never on another's.

| Record | Field | Statuses |
| --- | --- | --- |
| Order | `orders.status` | pending → confirmed → processing ("Packing") → packed → shipped → in-transit → out-for-delivery → delivered; or cancelled, returned |
| Packing job | `packing_jobs.status` | pending ("Waiting to pick") → picking → picked → packing → packed ("Ready to ship") → ready-to-ship ("Handed to shipping"); or cancelled |
| Shipment | `shipments.status` | pending ("Shipment created") → ready-for-pickup → pickup-scheduled → picked-up → in-transit → at-destination-hub → out-for-delivery → delivered; off the line: delivery-attempted, delivery-failed, returned-to-origin, cancelled |

Payment status (`orders.payment_status`) and stock state
(`orders.stock_state`) are also separate. They are guards, not stages.

The order page shows all three as one 13-step lifecycle:

> Order placed → Confirmed → Picking → Packing → Packed → Shipment created →
> Ready for pickup → Pickup scheduled\* → Picked up → In transit → At
> destination hub\* → Out for delivery → Delivered

\* Optional. A step passed without being visited shows as **skipped**.

## Who moves the order

Each order transition has an **owner**. The order status endpoint
(`PUT /admin/orders/{id}/status`) can only make the admin-owned moves.

| From | To | Owner | Reason |
| --- | --- | --- | --- |
| pending | confirmed | admin, payment | no |
| pending, confirmed | cancelled | admin, customer, payment, system | no |
| confirmed | processing | packing (picking starts) | no |
| processing | packed | packing (packing completed) | no |
| packed | processing | packing (repack) | **required** |
| processing, packed | cancelled | admin | **required** |
| packed | shipped → in-transit → out-for-delivery → delivered | shipment | no |
| shipped, in-transit, out-for-delivery | returned | admin, once the shipment has returned to origin | **required** |

Nothing leaves `delivered`, `cancelled` or `returned`. Items that come back
after delivery go through return requests (`services/returns.py`), which never
change the order's forward status.

Asking for any other move is refused, whatever the request says. The old
`confirm: true` flag is accepted for older clients but ignored.

- A move owned by packing or a shipment: 409 `WORKFLOW_OWNED`.
- A skip or a backward move: 409 `INVALID_TRANSITION`.

### Guards

| Guard | Error |
| --- | --- |
| Picking starts only if payment is `paid`, `cod-pending` or `partially-refunded`. | 409 `PAYMENT_REQUIRED`, e.g. "Order cannot be packed because payment is pending." |
| Picking needs the order's stock committed (`stock_state = consumed`). | 409 `STOCK_NOT_COMMITTED` |
| A prepaid order whose stock is only reserved is confirmed by its payment. | 409 `AWAITING_PAYMENT` |
| An order with an open shipment can't be cancelled. Cancel the shipment first. | 409 `SHIPMENT_ACTIVE` |
| A dispatched order can't be cancelled. | 409 `ORDER_NOT_CANCELLABLE`, "Order cannot be cancelled after shipment pickup…" |
| Customers can cancel online only while the order is pending or confirmed. | 409 `ORDER_NOT_CANCELLABLE` |
| A missing or too-short reason. | 422 `REASON_REQUIRED` |

## Packing

A confirmed order gets a packing job automatically, the next time the queue,
the dashboard or the order is read.

- **Start picking** moves the order to Packing.
- **Mark packed** moves it to Packed. It is refused until every picked unit is
  in a package and the checks pass.
- **Reopen a packed job** (repack) needs a reason, and moves the order back
  to Packing.

The **open queue** (All open, Waiting to pick, Picking, Picked, Packing, Ready
to ship) holds only the warehouse's work. Once a shipment takes a packed job
(`ready-to-ship`), the job leaves the open queue. It stays visible under
**Handed to shipping**. Shipped or delivered orders never appear in the open
queue.

## Shipments

A shipment is created from the order page, or by **Ready to ship** on the
packing job, which books it with the default courier (or asks for the AWB when
that courier is Manual; see docs/packing-and-labels.md).

A shipment can be created only in these cases (otherwise 409
`PACKING_INCOMPLETE`, `PAYMENT_REQUIRED` or `ORDER_NOT_SHIPPABLE`):

- The order is packed, and so is its packing job.
- To **record a missing shipment** for an order that was marked dispatched
  without one (see "Existing data" below).
- To **re-ship** an order after its shipment returned to origin.

An order has at most one active shipment, enforced by a unique key. A second
create request with a different idempotency key gets 409 `SHIPMENT_EXISTS`.
The same key returns the existing shipment.

### Manual moves

`POST /admin/shipments/{id}/status` takes `{ status, reason?, description?,
location?, occurredAt?, visible? }`. Each shipment lists its allowed moves in
`transitions`. Moves are strictly one step at a time:

| From | To |
| --- | --- |
| pending | cancelled (r). The courier moves it on once it confirms the booking. |
| ready-for-pickup | pickup-scheduled, picked-up, cancelled (r) |
| pickup-scheduled | picked-up, ready-for-pickup (r: pickup cancelled by the courier), cancelled (r) |
| picked-up | in-transit |
| in-transit | at-destination-hub, delivery-failed (r) |
| at-destination-hub | out-for-delivery, delivery-failed (r) |
| out-for-delivery | delivered, delivery-attempted (r), delivery-failed (r) |
| delivery-attempted, delivery-failed | out-for-delivery, returned-to-origin (r) |

(r) = a reason is required. Cancelling tells the courier. Scheduling a pickup
goes through the courier when it supports pickups. The older
`POST .../events` endpoint follows the same table. Sending the same status
again records a tracking note without moving the shipment.

### Courier updates

Courier updates (webhooks and polling) may pass over a scan the courier
never sent, but never move a shipment backwards or out of a terminal state
(`workflow.courier_can_move`).

### How the order follows

The order follows the shipment, forward only:

| Shipment status | Order status |
| --- | --- |
| picked-up | shipped |
| in-transit, at-destination-hub | in-transit |
| out-for-delivery | out-for-delivery |
| delivered | delivered |

A return to origin closes the shipment and frees the order. The admin then
either records the return (the order becomes returned) or re-ships.

## Inventory and money

- Stock is taken at the sale. Cash on delivery and paid orders consume it at
  once. A prepaid order holds it until the payment arrives.
- Packing and shipping never change stock, so moving between stages, forward
  or back, can't deduct twice.
- Cancelling an order, or recording a return to origin, gives the stock back.
  `stock_state` makes sure it happens once.
- Cancelling or recording a return also releases coupons and tenders (gift
  cards, store credit, points) and refunds what was collected. The refund is
  recorded first, then sent.
- Cash on delivery is marked paid when the shipment is delivered.

## Audit history

Every order status change adds an `order_events` row and never overwrites one.
Since migration `a7b8c9d0e1f2`, each row records:

- `from_status`: the status before the change
- `source`: admin, packing, shipment, payment, customer or system
- `reason`
- `related_type` / `related_id`: the packing job or shipment behind the change
- `actor` and `occurred_at`

Packing events and shipment events keep their own history. Admin actions are
also written to the audit log. The order page merges all three into one
history (`overview.history`).

## Order page API

`GET /admin/orders/{id}/fulfilment` returns:

- `progress`: every step, each marked completed, current, upcoming, skipped,
  exception or cancelled
- `nextActions`
- `packing`, including its packages
- `shipment`, including its transitions
- `shipments`, `returns`
- `warnings`
- `history`

Each action in `nextActions` has these fields:

- `kind`: `order`, `shipment`, `create-shipment` or `link`
- `allowed`, and a `blockedReason` when it isn't (payment, permission, no
  courier, an open shipment)
- `requiresReason`, `destructive`, `primary`

`POST /admin/orders/{id}/fulfilment/actions` takes `{ action, reason?, note?
}`. It answers with the fresh view.

| Action | Permission |
| --- | --- |
| `confirm`, `cancel`, `record-return` | `orders` |
| `start-packing`, `begin-packing`, `repack` | `packing` |
| Shipment moves | `shipments` |

## Shipments page API

`GET /admin/shipments/pipeline` reads only; it never creates anything. It
returns:

- `readyToShip`: packed orders waiting for a shipment. They are listed above
  the table, never as rows.
- `missingShipments`: dispatched orders with no shipment on record.
- `deliveredWithoutShipment`: a count, for information.
- `couriersActive`

The page says "No shipments yet" only when there are no shipment records, and
then says how many packed orders are waiting. Each row shows its next step
(`nextAction`).

## Existing data

Migration `a7b8c9d0e1f2` adds columns, each with a default. No row is
rewritten or deleted, and no shipment or packing record is invented. Records
from before the workflow was enforced are flagged on the order page
(`warnings`):

| Existing order | What happens |
| --- | --- |
| confirmed | Gets a packing job and appears in the packing queue. |
| processing, packing job never started (moved by hand) | Warning `PICKING_NOT_STARTED`. "Move to packing" continues it; the order doesn't move twice. |
| packed, with a packed job | Appears under Ready to ship. A shipment can be created. |
| packed, job not packed | Warning `PACKING_NOT_COMPLETE`. Packing has to be completed before a shipment. |
| shipped / in-transit / out-for-delivery, no shipment | Warning `NO_SHIPMENT_RECORD`. Listed on the Shipments page. "Record missing shipment" creates one with the courier and AWB the admin enters. |
| delivered, no shipment | Left as it is. Counted on the Shipments page. |

## Tests

- Backend:
  - `tests/unit/test_fulfilment_workflow.py`: every order and shipment
    transition, valid and invalid; owners, guards, the lifecycle states.
  - `tests/integration/test_order_fulfilment.py`: the end-to-end flow,
    actions, history, legacy data, the pipeline, permissions.
  - The packing, shipping and order suites.
  - `tests/integration/fulfilment_helpers.advance` takes an order to any
    status through the real workflow.
- Frontend:
  - `components/admin/views/fulfilment/Fulfilment.test.tsx`
  - `AdminShipmentsView.test.tsx`, `ManualEventDialog.test.tsx`
