# Product discovery

Five features that help a shopper find, keep and buy the right thing:

1. **Recently viewed products**: history that follows a signed-in customer between devices.
2. **Save for later**: bag lines put aside ("not now"), separate from the wishlist ("some day").
3. **Related products**: chosen by the store, then scored automatically, then fallbacks.
4. **Size guides**: reusable tables for any kind of product, in cm, inches or mm.
5. **Availability by location**: can *this variant* get to *this pincode*, and when.

They sit on top of what the store already had. None of them is a second copy of an
existing system:

| Feature | Built on |
|---|---|
| Recently viewed | the guest `recentlyViewedStore` (now timed), merged at sign-in like the guest bag |
| Save for later | `cart.add_item`, the bag's own add-to-bag checks, used for every move back |
| Related products | the old `GET /products/{id}/related` (same route, now `?type=`); the order history for "bought together" |
| Size guides | the product's own sizes (`product_sizes`) |
| Availability | `delivery_pincodes` + the `serviceability` settings; `Product.available_stock`; `orders.place_order`'s existing checks |
| Analytics | the existing `analytics_events` table and `/analytics/events` endpoint |

---

## Architecture

```
Storefront (Next.js)                    API (FastAPI)                         MySQL
───────────────────                     ─────────────                         ─────
RecentlyViewedRail / List ──┐           routes/discovery.py
useRecentlyViewed           ├─ signed in ─► recently_viewed.py ─────────────► recently_viewed_products
recentlyViewedStore (guest) ┘           │
GuestDataSync ── at sign-in ───────────►│ /recently-viewed/merge, /cart/saved/merge
SavedForLaterSection                    │
useSavedForLater ───────────────────────► saved_for_later.py ── cart.add_item ► saved_cart_items, cart_items
savedForLaterStore (guest)              │
RecommendationRail ─────────────────────► recommendations.py ── core/cache ──► product_relationships,
                                        │   (+ product_relationships.py)        order_items, product_tags…
SizeGuideDialog ── (server-rendered) ───► size_guides.py ──────────────────────► size_guides, size_guide_categories,
                                        │                                       product_size_guides
ProductAvailability, CartAvailability ──► availability.py ── serviceability.py ► delivery_pincodes,
                                        │                     core/cache        product_delivery_profiles/exclusions
checkout ── POST /orders ───────────────► orders.place_order → availability.enforce_for_order (locked rows)
```

### Guests and sign-in

A guest's recently viewed list and saved-for-later lines live in the browser
(`dcz:recently-viewed`, `dcz:saved-for-later`). They hold ids, variants,
quantities and view times, never a product copy or a price. `GuestDataSync`
(mounted in the storefront layout) posts them once the session is confirmed
and clears them only after the server accepts them; a failed request leaves
them to try again on the next page. The server de-duplicates and keeps the
newer of two views, so a merge that runs twice changes nothing.

### Caching (`app/core/cache.py`)

A small in-process cache with **namespaces and versions**: invalidating a
namespace bumps its version, so every entry stops matching at once.

| Namespace | What | TTL | Cleared by |
|---|---|---|---|
| `recommendations` | ranked product ids per product + type, and per shopper | `RECOMMENDATION_CACHE_SECONDS` | product create/update/delete, any relationship change |
| `delivery` | a pincode's answer and the serviceability rules | `AVAILABILITY_CACHE_SECONDS` | pincode add/edit/delete/import, delivery settings save |

**Never cached:** stock, price and publish status. A cached *ranking* is
always resolved against live rows: an unpublished product drops out at once,
and stock decides the order on every read. Checkout reads nothing from the
cache. The cache is per process, so with several workers an edit is seen at
once by the worker that made it and by the others within the TTL.

---

## 1. Recently viewed

- Recorded by the product page **after** the product has loaded. The page is
  server-rendered and a missing product is a 404 before the client runs, so an
  invalid id never reaches anyone's history. The server refuses drafts and
  unknown ids too (`404 PRODUCT_NOT_FOUND`).
- Repeats are cheap: the browser skips a product it recorded in the last 30 s
  (StrictMode double effects, back/forward), and the server skips a repeat
  within `REPEAT_SECONDS` (30 s) without writing.
- One row per customer and product (unique constraint). A re-view moves the
  product to the front and increments `view_count`.
- Bounded: `RECENTLY_VIEWED_LIMIT` (default 50) per customer, trimmed on every
  write. Rows older than `RECENTLY_VIEWED_RETENTION_DAYS` (180) are removed by
  the `discovery` background job (every 6 h, visible in System health).
- On read: unpublished products are left out (they come back if republished),
  out-of-stock ones are shown marked `availability: "out-of-stock"`, and deleted
  products cascade away.
- Guests keep 12 products in the browser.
- Analytics: `product_view` (existing), `recently_viewed_click` (browser),
  `recently_viewed_remove` and `recently_viewed_clear` (server).

**UI:** the rail on the product page and the homepage (hidden when empty), with
"View all" (`/account/recently-viewed` signed in, `/recently-viewed` for guests)
and "Clear all" (with a confirmation). The full list removes products one at a
time. There is an account menu entry.

## 2. Save for later

- **"Save for later"** on a bag line moves it out of the bag and into
  `saved_cart_items` in one transaction. The bag line is locked first, so a
  double click moves it once. The same variant merges quantities, capped at the
  bag's line limit (10). At most `SAVED_FOR_LATER_LIMIT` (100) lines.
- **"Move to bag"** goes through `cart.add_item`, the bag's own checks:
  published, in stock, size and colour still offered, the line limit, flash-sale
  limits. The bag then prices the line from the catalogue. If fewer are in stock
  than were saved, what is available moves and the response says so. When it
  can't move at all, the line stays saved and the reason is given.
- `saved_unit_price` is stored **only** to say "Price dropped from ₹X to ₹Y". It
  is never charged.
- Statuses: `available`, `limited`, `out-of-stock` (with "Notify me", the
  existing stock-alert button), `variant-unavailable` ("Choose another option"),
  and `unavailable` (withdrawn: removable, never purchasable).
- The wishlist stays separate. A saved line shows "Also in your wishlist" when
  it is, and removing one never touches the other. The bag's wishlist button is
  now labelled **Wishlist / In wishlist** so it can't be confused with **Save
  for later**.

**UI:** a "Saved for later" section under the bag, shown even when the bag is
empty. There is also an account page (`/account/saved-for-later`). The portal's
customer screen shows a customer's saved lines and recent history (read-only).

## 3. Related products

`GET /api/products/{id}/related?type=` with `type` one of `related` (default),
`similar`, `frequently-bought-together`, `alternative`, `accessory`.

1. **Store-chosen relationships** (`product_relationships`) come first, in their
   editorial order. `related` also includes the store's `accessory` choices.
2. **A weighted score** over every candidate sharing something with the product.
   Candidates are read as columns (a pool of 300), so the cost doesn't grow with
   the catalogue:

   | signal | weight |
   |---|---|
   | same subcategory | 40 |
   | same category | 25 |
   | bought in the same orders (last 365 days, cancelled excluded) | up to 35 |
   | same collection | 15 |
   | same brand | 12 |
   | shared tags | 6 each, max 4 |
   | price similarity (ratio of the two prices) | up to 10 |
   | popularity (rating, reviews, best-seller) | up to 10 |
   | out of stock | −60 (after everything in stock) |

3. **Fallbacks** for `related`: the category's best sellers, then the shop's.

Per type: `similar` leaves out co-purchase, `alternative` is the same
subcategory within ±35% of the price, and `frequently-bought-together` is only
store choices plus real co-purchases (an honest empty list beats an invented
"frequently"). The product itself, drafts, archived and deleted products are
never returned.

**"Recommended for you"** (`GET /api/recommendations/for-you`): signed in, built
from the account's recent views and purchases (purchased items left out); as a
guest, from the `seed` ids the browser sends. With no history it returns best
sellers. If the API can't be reached, the homepage rail falls back to the old
in-browser heuristic (`lib/recommendations/related.ts`).

**Analytics:** `recommendation_impression` (when a rail scrolls into view, once
per product and rail per session), `recommendation_click`, `add_to_cart` with
`source: "rec:<placement>"`, and `recommendation_purchase`, written at order
placement for any product added from a rail in the previous 7 days.

**Portal:** Products → Edit → **Related products**. Pick a type, search and add
products (optionally the reverse too), reorder, switch on and off, remove, and
**Preview**, which shows the rail exactly as shoppers get it, with where each
product came from (Chosen / Automatic / Bought together / Category best / Best
seller).

## 4. Size guides

A guide is a table the store defines: its own columns (`measurement` or
`text`), its own sizes and cells, how-to-measure steps, notes, a unit
(`cm`/`in`/`mm`), a kind (`clothing`/`footwear`/`ring`/`general`, which picks the
editor's starting columns), status and an optional *store default*.

Which guide a product shows:

```
the product's own guide (product_size_guides)
    ↓ otherwise, if the product comes in sizes
its category's guide (size_guide_categories)
    ↓ otherwise
the store's default guide
```

Inactive guides are skipped at every step. A product without sizes shows a
category or default guide only if it was given one of its own.

- **Validation:** a name (unique, case-insensitive), a unit, at least one
  column and one size, no duplicate column names or sizes (case and spaces
  ignored), and every required cell present. Measurements must be positive,
  have at most 2 decimals, a range can't end before it starts, and values must
  be below a plausibility ceiling (500 cm / 200 in / 5000 mm). Each error names
  the size and column.
- **Variants:** the response has `sizeMatch`: the product's sizes missing from
  the guide (warned in the portal), the guide rows the product isn't sold in
  (shown, marked "not available"), and `consistent`.
- **Units:** stored values are converted with exact factors (1 in = 25.4 mm)
  through `Decimal` and rounded once, to 0.1 (whole mm). Each row also carries
  the stored values, so the browser converts again from those and switching
  cm → in → cm shows the original. 92 cm reads 36.2 in.
- **"Find my size" later:** cells are numbers (`{min, max}`), which is what a size
  finder would compare against. No shopper measurements are collected.

**UI:** the "Size guide" link next to the size picker opens a dialog with a real
`<table>` (caption, column and row headers), a cm/in switch (remembered on the
device), how-to-measure steps and notes. Each size can be chosen straight from
its row, and focus returns to the link on close. Products with no guide keep the
old link to the FAQ's general charts.

**Portal:** Catalogue → **Size guides** (list, editor, categories, products,
delete with a usage count). Products → Edit → **Size guide** (assign or clear,
with the size check).

## 5. Availability by location

`GET /api/products/{id}/availability?pincode=&size=&color=&quantity=`

The answer combines:

- the product (published) and the **variant**: an unknown size or colour is
  `422 SIZE_UNAVAILABLE` / `COLOR_UNAVAILABLE`, and no size for a sized product is
  `select-variant`;
- **stock**: `available_stock` (on hand less reserved) against the quantity;
- the **pincode**: `serviceability.check` (the pincode table, then the
  "unlisted pincodes" rule);
- the product's **own rules** (`product_delivery_profiles`/`_exclusions`): places
  it isn't sent to (an exact pincode, a prefix such as `79` for a region, or a
  state), no COD, no express, handling days;
- the **estimate**: `serviceability.delivery_window`, which counts in the store's
  clock (`utcOffsetMinutes`), past the dispatch cutoff → next working day, then
  processing + handling days, then transit days, over working days only and
  skipping holidays;
- **COD**: store-enabled, available at the pincode, allowed for the product,
  under `codMaxOrderValue`, plus the COD fee;
- **express**: the pincode's express flag and the product's, with its own window
  and fee;
- the **fee**: the pincode's own or the store's standard, free over the
  threshold.

**Stock is per product.** This store holds one stock figure per product (not
per size or colour, and not per warehouse), so a variant is available when it
is one the product comes in and the product has stock. The response says
`inventoryScope: "product"`.

The **bag** (`GET /api/cart/availability?pincode=`) answers line by line, so
checkout can name the item that can't go there.

**Checkout checks it all again** inside `orders.place_order`, against the rows
it has locked: the pincode, stock, store-wide COD/express (as before), plus the
product rules (`PRODUCT_NOT_DELIVERABLE`, `COD_UNAVAILABLE`, `EXPRESS_UNAVAILABLE`)
and the COD limit (`COD_LIMIT_EXCEEDED`). The order's `expected_delivery` uses the
same window, including handling days. Stock reservation is unchanged: held
orders still reserve through `products.reserve_stock`.

The **defaults** reproduce the estimate the store always gave (dispatched
today, business days Monday–Friday, 3–5 days standard, 1–2 express), so nothing
changes until the store sets them.

**UI:** "Check availability" on the product page follows the chosen size,
colour and quantity. It is debounced, cancels the request in flight, reuses
answers for a minute, and remembers the pincode on the device. Checkout's
address and payment steps list the bag items that can't be delivered to the
chosen pincode, and switch off COD when any item disallows it.

**Portal:** Delivery pincodes → **Delivery estimates** (cutoff, processing days,
transit days, working days, holidays, COD limit). Products → Edit → **Delivery
rules** (COD, express, handling days, note, places it isn't sent to).

---

## Database

Migration `alembic/versions/20261007_0900_product_discovery.py` (revision
`7c1f4e2a9b35`, after `d7f9b1c3e5a7`). Purely additive: eight new tables, no
column on any existing table, no data written. It can be re-run after an
interruption, and the downgrade drops only these tables.

| Table | Key / constraints | Indexes | FKs (on delete) |
|---|---|---|---|
| `recently_viewed_products` | unique `(customer_id, product_id)` | `(customer_id, viewed_at)`, `(viewed_at)`, `product_id` | customer, product (CASCADE) |
| `saved_cart_items` | unique `(customer_id, product_id, size, color)` | `(customer_id, created_at)`, `product_id` | customer, product (CASCADE) |
| `product_relationships` | unique `(product_id, related_product_id, type)` | `(product_id, type, active, position)`, `related_product_id` | both products (CASCADE) |
| `size_guides` | PK `SZG…` business id | `status` | |
| `size_guide_categories` | PK `category_id` (one guide per category) | `size_guide_id` | category, guide (CASCADE) |
| `product_size_guides` | PK `product_id` (one guide per product) | `size_guide_id` | product, guide (CASCADE) |
| `product_delivery_profiles` | PK `product_id` | | product (CASCADE) |
| `product_delivery_exclusions` | unique `(product_id, kind, value)` | `product_id` | product (CASCADE) |

A product never relates to itself: the service refuses it, because MySQL
doesn't allow a CHECK constraint on a column with a cascading foreign key.

The `serviceability` settings document gains `dispatchCutoffHour`,
`processingDays`, `standardMinDays/MaxDays`, `expressMinDays/MaxDays`,
`workingDays`, `holidays`, `utcOffsetMinutes`, `codMaxOrderValue` (defaults in
`services/serviceability.DEFAULTS`).

## Configuration

`backend/.env.example`:

| Variable | Default | |
|---|---|---|
| `RECENTLY_VIEWED_LIMIT` | 50 | products kept per signed-in customer |
| `RECENTLY_VIEWED_RETENTION_DAYS` | 180 | history older than this is removed |
| `SAVED_FOR_LATER_LIMIT` | 100 | saved lines per customer |
| `RECOMMENDATION_CACHE_SECONDS` | 300 | ranking cache TTL (0 disables) |
| `AVAILABILITY_CACHE_SECONDS` | 120 | pincode-answer cache TTL (0 disables) |

No external services and no secrets.

## Permissions

| Area | Permission |
|---|---|
| Relationships, size guides, product size guide | `products` |
| Product delivery rules, delivery estimate settings | `shipping` |
| A customer's history and saved lines | `customers` |
| Recently viewed summary | `analytics` |

Every customer endpoint takes the customer from the verified token and puts
`customer_id` in the `WHERE`, so one customer can't read, change or remove
another's rows by id (404, not 403, so ids aren't probed). Admin tokens are
refused on customer endpoints and the other way round (the existing `actor`
claim). Pincode checks share the existing `pincode:<ip>` rate limit (60 / 5 min).
Recording a view is limited to 120/min per customer, and merges to 10/min.

---

## API reference

All responses use the standard envelope: `{ success, data, message }`, with
`pagination` on lists and `{ success: false, message, error_code }` on errors.
Money in **paise** where a field says so (`unitPrice`, `savedUnitPrice`,
`priceDrop`), rupees elsewhere.

### Recently viewed (customer token)

| Method & path | Request | Response | Errors |
|---|---|---|---|
| `GET /api/recently-viewed?page&pageSize(≤50)&exclude` | | list of `{productId, color, size, viewedAt, viewCount, available, availability, product}` + pagination | 401 |
| `POST /api/recently-viewed` | `{productId, color?, size?, source?}` | `202 {recorded: bool}` (false: a repeat) | 401, 404 `PRODUCT_NOT_FOUND`, 429 |
| `POST /api/recently-viewed/merge` | `{items: [{productId, viewedAt (ISO or ms; 0 = oldest), color?, size?}] (≤50)}` | `{merged, skipped}` | 401, 422, 429 |
| `DELETE /api/recently-viewed/{productId}` | | message | 401, 404 `NOT_IN_HISTORY` |
| `DELETE /api/recently-viewed` | | `{removed}` | 401 |

Example: `POST /api/recently-viewed {"productId":"PRD012","source":"search"}` → `202 {"success":true,"data":{"recorded":true}}`

### Save for later (customer token)

| Method & path | Request | Response | Errors |
|---|---|---|---|
| `GET /api/cart/saved` | | `{items: SavedItem[], limit}` | 401 |
| `POST /api/cart/items/{itemId}/save-for-later` | | `{saved, cart}` | 404 `CART_ITEM_NOT_FOUND`, 409 `SAVED_LIMIT_REACHED` / `SAVE_CONFLICT` |
| `POST /api/cart/saved/{id}/move-to-cart` | `{quantity?}` (1–10) | `{saved, cart, moved}`; the message says if fewer moved | 404 `SAVED_ITEM_NOT_FOUND` / `PRODUCT_NOT_FOUND`, 409 `OUT_OF_STOCK`, 422 `SIZE_REQUIRED` / `SIZE_UNAVAILABLE` / `COLOR_UNAVAILABLE` / `FLASH_SALE_LIMIT` / `INVALID_QUANTITY` |
| `PUT /api/cart/saved/{id}` | `{quantity}` (1–10) | `{items, limit}` | 404, 422 |
| `DELETE /api/cart/saved/{id}` | | `{items, limit}` | 404 |
| `DELETE /api/cart/saved` | | `{items: [], limit}` | |
| `POST /api/cart/saved/merge` | `{items: [{productId, size?, color?, quantity}] (≤50)}` | `{items, limit, merged, skipped}` | 422, 429 |
| `GET /api/cart/availability?pincode=` | | `{pincode, valid, serviceable, lines: [{lineId, productId, name, available, status, message, …}], allAvailable, unavailableCount, codAvailable, expressAvailable, estimatedDeliveryBy}` | 401, 429 |

`SavedItem`: `{id, productId, size, color, quantity, savedAt, unitPrice, savedUnitPrice, priceDrop: {from,to}|null, priceRise, status, message, maxQuantity, canMoveToCart, inWishlist, product}`.

### Public

| Method & path | Response | Errors |
|---|---|---|
| `GET /api/products/{id}/related?type&limit(≤24)` | `Product[]` | 404, 422 `INVALID_TYPE` |
| `GET /api/products/{id}/availability?pincode&size&color&quantity(1–10)` | see below | 404, 422 `SIZE_UNAVAILABLE` / `COLOR_UNAVAILABLE`, 429 |
| `GET /api/products/{id}/size-guide?unit=cm\|in\|mm` | a guide or `null` | 404, 422 |
| `GET /api/recommendations/for-you?limit&seed=PRD1,PRD2` | `Product[]` (signed in: the account's history; `seed` ignored) | |

Availability example (`?pincode=560001&size=M`):

```json
{
  "available": true, "status": "available", "message": "Available for delivery",
  "pincode": "560001", "deliverable": true, "inventoryAvailable": true, "inventoryScope": "product",
  "variant": { "size": "M", "color": "Black", "needsSize": false },
  "location": { "city": "Bengaluru", "state": "Karnataka", "listed": true },
  "estimatedDelivery": { "dispatchBy": "2026-10-05", "from": "2026-10-06", "to": "2026-10-08",
                         "label": "6–8 Oct", "latestLabel": "Thu, 8 Oct" },
  "codAvailable": true, "cod": { "available": true, "fee": null, "maxOrderValue": null, "reason": "" },
  "expressAvailable": true, "express": { "available": true, "estimatedDelivery": { "…": "…" }, "fee": 149 },
  "deliveryFee": 49, "standardDeliveryFee": 49, "freeDeliveryThreshold": 999, "freeDelivery": false
}
```

`status`: `available` · `limited` (fewer than asked) · `out-of-stock` · `select-variant` · `restricted` (a product rule) · `not-serviceable` · `invalid-pincode`.

### Portal (admin token)

| Method & path | Permission | Request → response |
|---|---|---|
| `GET /api/admin/products/{id}/relationships?type` | products | → `Relationship[]` |
| `POST /api/admin/products/{id}/relationships` | products | `{relatedProductId \| relatedProductIds[], type, active?, reciprocal?}` → all relationships · 404, 409 `DUPLICATE_RELATIONSHIP`, 422 `SELF_RELATIONSHIP` / `INVALID_RELATIONSHIP_TYPE` / `TOO_MANY` |
| `PUT /api/admin/products/{id}/relationships/{relId}` | products | `{active?, type?}` |
| `DELETE /api/admin/products/{id}/relationships/{relId}` | products | |
| `PUT /api/admin/products/{id}/relationships/order` | products | `{type, ids[]}` (every id of that type, once) · 422 `INVALID_ORDER` |
| `GET /api/admin/products/{id}/recommendations?type&limit` | products | → `{type, items: [{source, score, inStock, product}]}` |
| `GET /api/admin/size-guides?q&status&kind&page&pageSize` | products | → `{items, pagination, templates}` |
| `POST /api/admin/size-guides` | products | guide (cells may be typed `"92-97"`) · 409 `DUPLICATE`, 422 `SIZE_GUIDE_*` |
| `GET /PUT /DELETE /api/admin/size-guides/{id}` | products | PUT keeps fields not sent; DELETE → `{products, categories}` it was assigned to |
| `PUT /api/admin/size-guides/{id}/categories` | products | `{categoryIds[]}` → `{categories, movedFromOtherGuides}` |
| `PUT /api/admin/size-guides/{id}/products` | products | `{productIds[], mode: add\|remove\|replace}` |
| `GET /PUT /api/admin/products/{id}/size-guide` | products | `{sizeGuideId \| null}` → `{assignedGuideId, source, guide}` |
| `GET /PUT /api/admin/products/{id}/delivery` | shipping | `{codAllowed, expressAllowed, dispatchDays, note, exclusions: [{kind: pincode\|prefix\|state, value, reason}]}` · 422 `INVALID_EXCLUSION` / `INVALID_DAYS` |
| `GET /PUT /api/admin/delivery/settings` | shipping | the serviceability document (now with the estimate settings) · 422 `INVALID_SETTING` / `INVALID_DAYS` |
| `GET /api/admin/discovery/summary?days` | analytics | `{customers, entries, limit, retentionDays, topProducts}` |
| `GET /api/admin/customers/{id}/discovery` | customers | `{recentlyViewed, savedForLater}` |

Every portal write is audited: through the existing request capture, plus
explicit entries for `products.relationships.create/delete`,
`size-guides.create/update/delete/assign` and `products.delivery.update`.

---

## Testing

```bash
cd backend
TEST_DATABASE_NAME=dcz_test_discovery python -m pytest tests/integration/test_recently_viewed.py \
  tests/integration/test_saved_for_later.py tests/integration/test_recommendations.py \
  tests/integration/test_size_guides.py tests/integration/test_availability.py \
  tests/integration/test_discovery_journeys.py tests/unit/test_discovery_units.py
cd ../frontend
npx vitest run src/components/products src/components/cart src/components/growth \
  src/components/admin/views/discovery src/lib/discovery src/store
```

The journeys file walks the five end-to-end flows through the API (guest
history → sign in; save for later and back; related → bag → order credited to
the rail; size guide units and variant; availability → checkout re-checks).
There is no browser E2E framework in this repository.

## Deployment

1. Deploy the backend. `alembic upgrade head` (run at startup when
   `AUTO_MIGRATE` is on) creates the eight tables. Nothing else changes until
   it runs, because no existing table gains a column.
2. Optionally set the variables above (the defaults are sensible).
3. Deploy the frontend.
4. In the portal: create size guides and assign them, set delivery estimates
   (cutoff, holidays) under Delivery pincodes, and choose relationships on the
   products that need them.

## Not included

- **Warehouses / per-location stock.** The store holds one stock figure per
  product by design (see `models.catalogue.Product`), and reservations, the
  stock ledger and purchase orders all work against it. Availability is
  location-aware through the pincode table, the product's own delivery rules
  and the delivery window, not through per-warehouse stock. Adding warehouses
  would mean splitting stock, reservations and the ledger, which is a decision
  of its own.
- **Per-variant stock.** For the same reason, a size or colour is "available"
  when the product is (`inventoryScope: "product"`).
- **Find my size.** The data shape supports it; it collects nothing today.
