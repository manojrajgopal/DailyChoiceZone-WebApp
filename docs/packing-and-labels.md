# Packing and shipping labels

Between "confirmed" and "handed to the courier", the warehouse picks and packs
each order. The store then prints its own shipping label for every shipment,
whichever courier carries it.

- Backend: `app/services/fulfilment/` (`packing.py`, `labels.py`,
  `label_pdf.py`, `settings.py`), with routes in `app/api/routes/packing.py`.
  Each module's docstring lists the rules it keeps.
- Portal: `frontend/src/components/admin/views/packing/`, with the service in
  `services/admin/packingAdminService.ts` and the types in `types/packing.ts`.

## Permissions

| What | Permission |
| --- | --- |
| Packing queue, packing workspace, packing slip | `packing` |
| Shipping labels (single and bulk) | `shipments` |
| Packing and label settings | `settings` |

The server checks every permission. The portal hides a card or panel when the
server answers 403: the order page's packing card, the settings panel.

## The packing flow

```
pending ──start picking──▶ picking ──picking complete──▶ picked ──start packing──▶ packing
   ▲                          │                                                    │
   └──── reopen (reason) ─────┴──────────── reopen (reason) ◀── packed ◀── mark packed
                                                                  │
                                                            ready to ship
```

- **Jobs are made automatically.** Every confirmed, processing or packed order
  gets exactly one job the next time the queue, the dashboard or the order's
  packing card is read.
- **Status changes go through the order.** Starting to pick moves the order to
  `processing` ("Packing"), and marking it packed moves it to `packed`.
  Reopening a packed job (with a reason) moves the order back to Packing. Only
  packing may make these moves (docs/order-fulfilment.md), so the customer
  messages go out exactly once.
- **Payment first.** Picking starts only when the payment allows fulfilment
  (paid or cash on delivery); otherwise `PAYMENT_REQUIRED`.
- **Ready to ship creates the shipment.** On a packed job, Ready to ship
  (`POST /api/admin/packing/{id}/ready`) hands the packages to the order's
  shipment, creating one when there is none. It uses the default courier (or
  `providerCode`) and the packages' total weight and largest size. A courier
  with an API (Shiprocket) is booked straight away. A Manual courier needs its
  name and the AWB: without them the answer is 409 `SHIPMENT_DETAILS_REQUIRED`,
  and the page opens the shipment form to ask. With no courier switched on the
  answer is 409 `NO_COURIER`. Send an `idempotencyKey` so a retried click
  can't book twice.
- **The open queue is the warehouse's.** A job handed to a shipment
  (`ready-to-ship`, "Handed to shipping") leaves the open queue.
- **Problems on the shelf.** A line can be flagged as missing stock, damaged or
  wrong item, with a quantity and a note. A flagged line blocks "picking
  complete" unless the problem is cleared, or someone overrides it with a
  reason of at least 3 characters (error `PICK_EXCEPTIONS`).
- **Damaged stock** is written off separately, through the stock ledger with
  the reason `damaged`. Picking itself never changes stock, because stock was
  taken at the sale.
- **Packages.** An order can go in one parcel or several. Each package records:
  - type: box, envelope, polybag, tube, crate or other
  - weight: whole grams, 1 to 100000
  - length, width and height: 0.1 to 300 cm
  - notes (up to 300 characters)
  - which units it holds

  The volumetric weight is L × W × H ÷ the volumetric divisor. Putting more
  units in packages than were picked is refused (`OVER_ALLOCATED`).
- **Checks before packing.** Errors can't be overridden. Warnings ("critical")
  can be overridden with a confirmation and a reason (`CONFIRMATION_REQUIRED`).
- **No silent edits.** Once a job is packed, its packages are locked. Changing
  them means reopening the job, to picking or packing, with a reason. Every
  action writes a packing event (shown as the workspace's History) and an
  audit entry.
- **Cancellation.** Cancelling an order cancels its job.

### Packing slip

`GET /api/admin/packing/{id}/slip` returns a PDF. Add `?prices=true|false` to
override the default (Settings → Couriers → Packing & labels), and
`&download=true` to download it. The workspace offers Preview (opens in a new
tab), Print (prints from a hidden frame) and Download.

## Shipping labels

- **What's on a label.** Seller, buyer, shipment, packages, items and the COD
  amount, frozen as a snapshot when the label is made. The PDF is drawn from
  that snapshot on every request, so an old version reads exactly as it was
  printed. No files are stored.
- **Sizes.** Thermal 4 × 6 in, Standard A6, or A4 with one label per page. The
  default is a setting; staff can choose a size for each label.
- **Lifecycle.**
  - Generating again returns the current label.
  - Regenerating needs a reason. The old version becomes "Superseded".
  - Cancelling needs a reason. The label can no longer be printed.
  - All versions stay in the history, with who made each one and why.
- **Failures.** A label that can't be made is recorded as a failed version,
  with the reason. Typical reasons:
  - a missing address, pincode, phone, weight, dimensions or SKU
  - no AWB
  - a cancelled shipment
  - a PDF failure

  The panel lists what's still missing before you try.
- **Courier labels.** A courier's own label (Shiprocket) is a different thing.
  On the shipment page it appears as "Get courier label" / "Courier label",
  and the store label panel also links to it.
- **Bulk.** On the Shipments list, tick up to 100 rows, then:
  - Generate labels: each shipment on its own; failures are listed by shipment
    and never stop the rest.
  - Print labels: one merged PDF.
  - Download ZIP: one PDF per shipment.

  Shipments without a printable label are skipped. The server reports them in
  the `X-Labels-Skipped` header, and the page says how many were skipped.

## Settings (`/api/admin/fulfilment/settings`)

| Setting | Default | Range |
| --- | --- | --- |
| `slaHours`: an order waiting longer shows as overdue | 24 | 1–336 |
| `volumetricDivisor` | 5000 | 1000–10000 |
| `slipShowPrices` | off | |
| `labelFormat` | `thermal-4x6` | `thermal-4x6`, `standard`, `a4` |
| `defaultPackage`: starting values for a new package | none | as a package |

Saved changes are audited (`fulfilment.settings`). The portal edits these
under Settings → Couriers → Packing & labels.

## Portal screens

| Screen | Where |
| --- | --- |
| Packing queue: summary tiles, status tabs, filters kept in the URL, overdue highlighting | `/admin/packing` (sidebar: Sales → Fulfilment → Packing) |
| Packing workspace: pick list, problems, damaged stock, packages, checks, slip, delivery, shipment, history | `/admin/packing/job?id=` |
| Packing card | Order page |
| Store label panel | Shipment page |
| Label column, selection, bulk bar | Shipments list |
| Packing & labels settings | Settings → Couriers |

Tests: `components/admin/views/packing/Packing.test.tsx`, with fixtures in
`test/packing-fixtures.ts`.
