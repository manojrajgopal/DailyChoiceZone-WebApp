# Daily Choice Zone — storefront, admin portal & billing

**Quality products, happier you.**

A working e-commerce application in two parts: a Next.js frontend with three
surfaces over the same data — the customer storefront at `/`, an administration
portal at `/admin`, and a billing system that runs through both — and a FastAPI
backend on MySQL that owns every one of them.

| | |
|---|---|
| Frontend | Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind v4 · Zustand |
| Backend | FastAPI · SQLAlchemy 2 · MySQL · Alembic · Pydantic v2 · JWT |
| Data | MySQL, through a REST API — nothing business-related ships in the bundle |

The split is the point. The browser renders; the server decides. Prices,
discounts, coupons, tax, delivery, stock, totals, invoice numbers and who is
allowed to do what are all worked out in one place, by the same code that
charges the card and writes the invoice.

- **Backend documentation** — [`backend/README.md`](backend/README.md)

---

## Getting started

Two processes. Start the API first; the frontend renders on the server and asks
it for everything.

You need **Python 3.11+**, **Node 20+**, and a **MySQL 8+** server running.

```bash
# 1 — the API
cd backend
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env          # macOS/Linux: cp .env.example .env
python -m uvicorn app.main:app --reload
```

```bash
# 2 — the site
cd frontend
npm install
npm run dev
```

The API creates its database, migrates it and loads the demo data on first
start — 139 products, 64 customers, 168 orders with their invoices, payments,
refunds and credit notes. Nothing to import by hand.

| | |
|---|---|
| Storefront | <http://localhost:3000> |
| Admin portal | <http://localhost:3000/admin> |
| API | <http://localhost:8000/api> |
| API documentation | <http://localhost:8000/docs> |

### Demo accounts

| | Email | Password |
|---|---|---|
| Administrator | `admin@dailychoicezone.com` | `Admin@123` |
| Customer | any seeded customer, e.g. `aditya.banerjee1@example.com` | `Customer@123` |

Hashed with bcrypt like any other account. Change them before this is in front
of anybody.

### Scripts

| Frontend | |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve the build on Node |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run brand:assets` | Regenerate sized logo assets |

| Backend | |
|---|---|
| `uvicorn app.main:app --reload` | Development server |
| `pytest` | The whole suite (258 tests) |
| `python -m app.seed.reset --yes` | Rebuild the development database from the seed |
| `alembic revision --autogenerate -m "…"` | New migration |

### Environment

The frontend needs one variable, and has a sensible default:

| Variable | Default | |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000/api` | Where the API is |

The backend's are in [`backend/.env.example`](backend/.env.example) and
documented in its README. **None of them reach the browser** — no database
password, no JWT secret, no payment key.

---

## Architecture

Data flows one way, and each layer only knows about the one below it.

```
MySQL
  ↓
FastAPI                    services decide; routes only speak HTTP
  ↓   REST, one envelope
services/api/client.ts     the only place that knows the base URL and the token
  ↓
services/adapters/         the only place that knows where data comes from
  ↓
services/*Service.ts       named business intentions (getNewArrivals, applyCoupon)
  ↓
hooks/                     React state, loading and error handling
  ↓
components/                presentation
  ↓
app/                       routes and metadata
```

The rule that keeps it honest: **no component imports business data, and no
component imports an adapter.** Components call services, or hooks that call
services. That is why moving from bundled JSON to a real database changed the
adapters and nothing above them.

```
frontend/src/
├── app/                  routes, metadata, sitemap, robots
├── components/
│   ├── ui/               design system (Button, Price, Rating, Dialog, …)
│   ├── common/           Logo, ProductImage, empty/error states, variant pickers
│   ├── layout/           header chrome, footer, content-page shell
│   ├── navigation/       header, mega menu, mobile nav, search overlay
│   ├── products/         card, grid, rail, gallery, listing, quick view
│   ├── filters/          filter panel and active-filter chips
│   ├── home/             the config-driven homepage section renderer
│   ├── cart/  wishlist/  checkout/  account/
│   ├── admin/            the portal: layout, ui, charts, views
│   └── billing/          invoice document, breakdown rows, status badges
├── config/               menu structure — frontend configuration, not business data
├── services/
│   ├── api/client.ts             base URL, token, envelope, errors — one place each
│   ├── data-source.ts            the storefront contract
│   ├── adapters/http-adapter.ts  it, over the API
│   ├── admin/                    the portal's contract and its services
│   └── billing/                  invoices, payments, refunds, credit notes, config
├── hooks/                useCart, useWishlist, useProducts, useProductQuery, …
├── store/                cart, wishlist, session, checkout, recently viewed, toasts
├── lib/                  filters, recommendations, formatting, storage, money
└── types/                the domain model (+ admin.ts, billing.ts)
```

```
backend/app/
├── main.py               routers, CORS, error handlers
├── core/                 config, database, security, errors, startup
├── models/               32 tables
├── schemas/              Pydantic in and out — camelCase on the wire
├── repositories/         the SQL complex enough to deserve a name
├── services/             the business rules
├── api/routes/           HTTP only
├── dependencies/         who is calling, and what they may do
└── seed/                 the demo data and its id translation
```

### The seam between them

The API emits **camelCase**, because a Pydantic alias generator is cheaper than
a mapping layer nobody maintains. `ProductOut` serialises to exactly the shape
`types/product.ts` already described, so the adapters are mostly one line per
method.

Every response uses the same envelope, including failures:

```jsonc
{ "success": true,  "data": { }, "message": "Signed in." }
{ "success": true,  "data": [ ], "pagination": { "page": 1, "page_size": 24, "total": 139, "total_pages": 6 } }
{ "success": false, "message": "That coupon has expired.", "error_code": "COUPON_INVALID" }
```

`client.ts` unwraps it, turns a failure into an `ApiError` carrying a stable
`error_code`, and attaches the right bearer token. Components see data or an
error; nothing in between.

---

## Things worth knowing before you change something

**Filtering, sorting and paging happen in SQL.** `GET /api/products` takes the
category, the search term, the price range, the flags, the sort and the page.
The browser does not download a catalogue to filter it — that stops working at
the first catalogue that does not fit in memory, and stops being fast well
before that. A page size is capped server-side, so no single request can ask it
to serialise everything.

**Filters live in the URL, not in component state.** `useProductQuery` reads and
writes the query string, so a filtered view is shareable, bookmarkable and
correctly undone by the back button. `/shop`, every category page and search are
the same `ProductListing` component with a different `basePath`.

**The homepage is data.** Its sections, their order and their titles are rows an
administrator edits. `app/page.tsx` renders whatever the API describes. Adding a
new *kind* of section means adding a case to `HomeSectionRenderer.tsx`.

**Navigation is the one thing still in the repository**, in `src/config/`. Every
entry names a route that has to exist in `src/app`, and the header renders on
the first paint before any request has been made.
[`src/config/README.md`](frontend/src/config/README.md) says why, and what would
change if menus ever became something a non-developer edits.

**Route groups keep the two applications apart.** `app/(storefront)/` carries
the customer header, promo strip and footer; `app/admin/(portal)/` carries the
portal's sidebar and top bar. Neither layout can leak into the other, and the
URLs are unaffected.

**The cart is the server's.** Signed in, the lines *and* every figure on them
come from `GET /api/cart`. Signed out, the bag is staged in local storage as ids
and quantities only, priced as a subtotal and nothing else — delivery, coupons
and tax are the server's to decide, and quoting a guest a total the checkout
then disagrees with is worse than quoting none. `mergeGuestCart` posts the bag
up on sign-in. The wishlist works the same way.

**Local storage holds a token and a staging bag. Nothing else.** No prices, no
orders, no customer records — and never a card number, CVV, UPI PIN, bank
credential or gateway secret. `lib/storage/local-storage.ts` wraps every access,
because local storage throws in private browsing and when a user blocks site
data; a storefront must not white-screen because someone tightened their browser
settings.

**Anything driven by local storage waits for hydration.** The cart badge,
wishlist hearts and recently viewed render their empty state on the server and
fill in on the next paint, via `useHydrated`. Checkout's step guards use
`useCheckoutHydrated`, which waits for zustand to actually rehydrate — otherwise
refreshing the payment step would bounce you back to step one.

**Scrollbars are styled globally, in two dialects.** Chromium supports both the
standard `scrollbar-width`/`scrollbar-color` *and* the `::-webkit-scrollbar`
pseudo-elements — and when both are set the standard properties win, silently
discarding the rounding and insets. So `globals.css` splits them with
`@supports … (not selector(::-webkit-scrollbar))`: Firefox gets the standard
properties, everything else gets the richer version. Collapsing that into one
block looks tidier and breaks the styling in Chrome.

The portal's sidebar keeps its scrollbar rather than hiding it — with Billing
expanded the navigation genuinely runs past the fold on a laptop, and a pane
that scrolls without saying so hides half its own contents. It is made quiet
instead: a translucent white thumb on the dark ground, brighter on hover.
`.no-scrollbar` still wins on the product rails, which are swiped rather than
scrolled and carry their own arrows.

---

## Rendering

Every page is rendered per request on Node.

It used to be a static export — plain HTML written to `out/`, servable by any
host with no process behind it. That worked while every figure was baked into
the bundle at build time. It stopped working the moment the data moved to
MySQL: a static export can only render what was true when it was built, so an
administrator changing a price would have needed a redeploy before anyone saw
it, and pages that depend on who is asking would have had nothing to render on
the server at all.

So `/product/[slug]`, `/category/[slug]` and `/collection/[slug]` are rendered
on demand rather than enumerated at build time. A product published this morning
works this morning, and `notFound()` still returns a genuine 404 for a slug that
does not exist — which is what stops unknown URLs becoming indexable soft-404s.
The sitemap is generated per request for the same reason.

**Deployment:** two services. A Node host running `next build && next start` for
the frontend, and a Python host running Uvicorn for the API, with
`NEXT_PUBLIC_API_URL` pointing at it and `CORS_ORIGINS` pointing back.

---

## Admin portal

`/admin` — a portal for running the store: catalogue, inventory, orders,
customers, coupons, reviews, merchandising, billing and reports.

```
/admin/login          sign in
/admin/dashboard      KPIs, sales charts, recent orders, low stock
/admin/products       list · new · edit          /admin/categories
/admin/inventory      stock levels + adjustments  /admin/collections
/admin/orders         list · detail · status      /admin/customers
/admin/coupons        /admin/reviews              /admin/homepage
/admin/banners        /admin/reports              /admin/settings
/admin/billing/*      invoices · payments · refunds · credit notes
```

### Authentication and authorisation

The password is verified on the server against a bcrypt hash. The token that
comes back carries an `actor: "admin"` claim, and every admin endpoint checks
it — a customer's token is a perfectly valid token and will not do.

**Authorisation is enforced by the API**, per request, by `require_permission`.
The portal's `can()` decides which buttons to draw, which is a courtesy to the
person using it and not a boundary. The route guard in `AdminShell` is the same:
it stops a signed-out visitor seeing a broken shell, and bypassing it reaches a
portal with nothing in it, because every figure on every screen comes from a
call that validates a token.

The demo credentials are shown on the login page deliberately — the seeded
database ships with one administrator, and a login form whose password nobody
can discover is a locked door with no key. Change them before this is public.

`/admin` is excluded from `robots.txt` and marked `noindex`, which keeps it out
of search results. That is hygiene, not access control; the access control is
the token.

### One catalogue, two views

There is a single product record — one table, not two.

```ts
export type AdminProduct = Product & ProductManagement;
```

The customer-facing fields and the management fields (status, thresholds,
reserved stock, SEO, audit dates) are columns on the same row. The storefront
reads the subset filtered to `active` and `out-of-stock`; drafts and archived
products are invisible to customers, which is the only thing that makes the
Draft state mean anything.

**Stock lives on the product**, not in a separate inventory table — a second
copy of the quantity is two numbers that can disagree. The *ledger* of changes
earns its own table, so every movement, whether a stock count or a sale, has a
row explaining it.

Orders store `product_id` and a snapshot of what was bought, never a reference
to the live product. An order's value must never be recomputed from the current
catalogue: a repriced product would silently rewrite last month's revenue, and a
deleted one would erase the line entirely.

### What reaches the storefront

All of it, immediately. There is no build-time gap any more: a price change, a
new product, a reordered homepage, an approved review and a rescheduled banner
are all visible on the next request, because the next request asks the database.

---

## Billing

Cart to checkout to invoice to refund, through the same records the storefront
and the portal already use. An order, its invoice, its payment and any refund
are rows related by id, and both applications read the same ones.

### One calculation, one place

`app/services/billing.py` produces the breakdown. The bag, every checkout step,
the placed order, the invoice, the admin order page and the reports all render
what it returns. A component that did its own subtraction would eventually
disagree with one that did not, and a checkout that quotes two different totals
has already lost the sale.

The frontend used to have its own copy of this arithmetic. It does not any more
— two implementations of the same sum is exactly how a cart comes to quote a
total the checkout disagrees with.

### Money is integers

Every billing amount is an integer in the currency's minor unit — paise. Never a
float. `0.1 + 0.2` is not `0.3` in binary floating point, and a rounding error of
a hundredth of a rupee per line becomes an invoice that does not add up.

### Tax

Indian GST, configurable from the portal. Supply inside the seller's own state
splits into CGST and SGST; supply across a state line is a single integrated
tax. Which applies is decided by the **billing** address, per line, because
rates vary by category and an invoice has to show the tax against each item.

Prices are tax-inclusive, so the tax is *extracted* rather than added — the
customer pays what the shelf said and the invoice shows how that splits. CGST
and SGST are each half of the *total*, not half of the rate, so the two halves
always reconcile.

An order-level coupon is apportioned across lines before tax, by value, using a
largest-remainder allocation that sums back exactly. Without it the line taxes
would not reconcile with the invoice total — the error an auditor finds first.

**It is a configurable representation of GST, not a compliance implementation.**
Real treatment depends on HSN classification, exemptions, reverse charge and
place-of-supply rules that belong with professional advice.

### Invoices, payments, refunds

An order, its stock movement, its invoice, its payment and its coupon usage are
written **in one transaction**. All of it or none of it — the browser can be
closed between any two steps, and the frontend used to be orchestrating four
separate writes.

Invoice and credit-note numbering is the server's. A number minted in a browser
is a number two tabs can mint twice, and a duplicate invoice number is not a
display bug; it is a bookkeeping problem that outlives the session.

A refund is a request first and a movement of money second, which is why it has
its own record rather than being a flag on the payment. Only a *completed*
refund touches the payment and the invoice, and the over-refund check runs
against what the **payment** has left rather than what the invoice was worth —
two partial refunds that each look reasonable can together exceed what was
actually collected.

### Payments

`PaymentProvider` is an interface — create, verify, fetch, refund — and
`PAYMENT_PROVIDER` picks the implementation. The one that ships moves no money
and returns believable transaction ids, which is what lets the whole order flow
be exercised without an account anywhere.

Adding Razorpay, Cashfree, PayU or Stripe is one class in
`backend/app/services/payments/` and one environment variable. **It is all
server-side**, because creating a payment, verifying a signature and handling a
webhook are secret-key operations, and a secret key in a browser bundle is not a
secret. Nothing in the frontend names a gateway.

---

## Security

The properties, and where each is enforced. The backend README has the detail.

| | |
|---|---|
| Passwords | bcrypt, per-hash salt, no plaintext column anywhere |
| Sessions | JWT with an `actor` claim — a customer token cannot open an admin endpoint, or the reverse |
| Authorisation | `require_permission` in the API. Hidden buttons are a courtesy, not a check |
| Money | Price, discount, coupon, tax, shipping, total and payment status are recalculated server-side at order time. A payload naming its own total changes nothing |
| Card data | Never collected, stored or transmitted. The only payment detail kept is a masked hint a gateway returns *after* processing |
| Gateway keys | Backend only. The frontend does not know which provider is in use |
| Secrets | `.env`, never the bundle. No database password or JWT secret reaches the browser |
| Errors | Driver messages and stack traces are logged, never returned — they describe your schema to whoever asked |
| Production | Refuses to start with a default JWT secret, `DEBUG` on, wildcard CORS, or seeding enabled |
| Migrations | Upgrade only. Nothing drops a table automatically |

---

## Tests

```bash
cd backend && pytest
```

258 tests against MySQL, in a database of their own. Money and tax arithmetic
against worked examples, password hashing and token forgery, registration and
sign-in, catalogue filtering and paging, the cart and its pricing, the
wishlist's uniqueness, the order transaction and what the client is not allowed
to decide, coupons, inventory and its ledger, refunds and credit notes, and —
endpoint by endpoint — who is allowed to call what.

The frontend is checked with `npm run typecheck` and `npm run lint`.

---

## The demo data

`backend/app/seed/data/` holds the JSON the database is seeded from. It used to
live in the frontend bundle; it lives there now because it is *seed* data, and
the browser has no business shipping it.

The generators are in `backend/app/seed/generators/`:

```bash
node app/seed/generators/generate-products.mjs      # catalogue and reviews
node app/seed/generators/generate-admin-data.mjs    # orders, customers, analytics
node app/seed/generators/generate-billing-data.mjs  # invoices, payments, refunds
node app/seed/generators/check-data.mjs             # validate all of it
```

`check-data.mjs` does not merely confirm the files parse. It **re-derives every
stored total from its own components** and fails if they disagree: lines against
subtotal, apportioned discounts against the coupon, line tax against invoice
tax, CGST + SGST + IGST against the total, and the whole breakdown against the
grand total.

Seeding is idempotent by primary key, so a restart neither duplicates anything
nor overwrites a change made through the portal.

### Dummy images

Product photography is Unsplash URLs held on the product rows. To move to a real
CDN: change the URLs and add the host to `remotePatterns` in `next.config.ts`.
`ProductImage` falls back to an on-brand placeholder if a URL fails to load.

---

## What is deliberately not real

Honest about it in the UI rather than pretending:

- **No payment gateway.** Checkout collects a payment *method*, never a card
  number, CVV or UPI ID. A real integration hands off to the provider's own
  hosted fields — which is also how it should work in production.
- **No money moves.** The mock provider returns a plausible reference and
  nothing else. Refunds adjust records; no funds are returned.
- **Nothing is fulfilled.** Orders are real records with real stock movements
  and real invoices. No parcel leaves anywhere.
- **Forms do not send.** The contact form and newsletter confirm and clear.
- **The tax figures are not a compliance calculation.** [Details](#tax).
- **The demo credentials are public**, on purpose, and are the first thing to
  change.

---

## Brand

The design system is derived from the logo in `public/brand/logo.png` — the
cream disc, the copper ring, the near-black of "Daily", the terracotta of
"Choice", the green leaf and the blush/sage/peach trust icons. Every colour,
type and spacing token lives in `src/app/globals.css` under `@theme`.

Components should reach for a token rather than introducing a new value. The
palette is intentionally narrow: warm neutrals and one accent, so product
photography carries the colour.

Typography pairs a high-contrast serif (Playfair Display) with a quiet grotesque
(Inter), which is the same relationship the logo strikes between "Daily Choice"
and the wide-tracked "ZONE".

The portal has its own visual language: denser spacing, tighter radii, a neutral
working surface, brand copper used only as an accent. It reads as a tool rather
than a shopfront, while still belonging to the same brand. Its charts are
hand-built SVG, sized from a `ResizeObserver`, with a palette validated for
colour-vision deficiency rather than chosen by eye — and deliberately no
dual-axis chart anywhere, because two measures of different scale get two charts.

---

## Accessibility

Not an afterthought, and worth preserving:

- Semantic landmarks, a skip link, and one consistent copper focus ring.
- Modals and drawers are Radix-based: focus trapped and restored, Escape and
  outside-click dismiss, the rest of the page hidden from assistive tech.
- Size and colour pickers are real radio groups; quantity is a spinbutton.
- Icon-only buttons all carry accessible names, and colour swatches name their
  colour rather than relying on the swatch alone.
- The mega menu opens on keyboard focus, not hover alone.
- `prefers-reduced-motion` flattens every animation.
