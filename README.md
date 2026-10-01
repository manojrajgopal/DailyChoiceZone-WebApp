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

The API creates its database and migrates it on first start. **It loads no
data** — a fresh installation is a configured store with an empty catalogue,
which is what a real shop starts as.

| | |
|---|---|
| Storefront | <http://localhost:3000> |
| Admin portal | <http://localhost:3000/admin> |
| API | <http://localhost:8000/api> |
| API documentation | <http://localhost:8000/docs> |

### Getting in the first time

Nobody is created for you. **The first account to register becomes the
administrator.** Open the storefront, create an account, and that account can
sign in at `/admin` as a super admin. Everyone who registers after them is an
ordinary customer.

The role is decided on the server from the state of the table, never from the
request — details in [`backend/README.md`](backend/README.md#the-first-administrator).

From there the portal fills the shop: products, categories, collections,
coupons, banners, the homepage, the menus and every list either application
renders.

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
| `pytest` | The whole suite (400 tests) |
| `alembic upgrade head` | Apply migrations |
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
└── config_defaults/      the configuration a fresh install starts with, once
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

**Nothing in the frontend is a data file.** There is no JSON under `src`, and no
component holds a list of business data. The menus, the states a delivery
address can name, the contact form's topics, the delivery and payment methods
on offer, the sort orders, the filter buckets, the FAQ, the size charts and
every dropdown in the portal all come from `GET /api/site/content` and
`GET /api/site/navigation`. Each of them was an array in a component; each of
them is now something the store can change without a deployment.

**And every one of them has a screen.** Settings → Site, Content and
Navigation edit those documents directly: add a row, reorder it, remove it,
save. Nothing has to be changed in a file to change what the shop shows.

Two things stay in code, and neither is data: which icon a named entry draws
(an API cannot send a React component, so the document names one and one map
resolves it), and the permissions each admin role carries — that is policy the
server enforces, and putting it somewhere an administrator could edit would let
one grant themselves the right to grant permissions.

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

So `/product/[id]`, `/category/[slug]` and `/collection/[slug]` are rendered on
demand rather than enumerated at build time. A product published this morning
works this morning, and `notFound()` renders the not-found page for anything
that does not exist. The sitemap is generated per request for the same reason.

### Products are addressed by id

`/product/PRD118`, not `/product/woven-webbing-belt`. The id identifies the
product; the slug identifies what it was *called* when the link was made.
Renaming a product in the portal changes its slug, and every link anybody had
saved — a bookmark, a message to a friend, an indexed result — stopped working.

The slug has not gone away. It is still an editable SEO field, and
`GET /api/products/{identifier}` answers to either key, so an old link resolves;
the page then redirects it to the id URL, and `alternates.canonical` names the
id URL so a crawler knows which of the two to index. `GET /api/products/slug/…`
is gone, folded into the one route — one resource, one route, the same rule
categories and orders already follow.

Every link in both applications is built from `product.id`, including the
sitemap and the cart, order and wishlist rows, which have a `productId` to hand.

### What a page is allowed to ask for

A page makes the requests its own sections need, and no others. That is a rule
worth stating because the static export left behind a whole class of code that
broke it: components that re-read on mount because the HTML they were rendered
into might have been built weeks ago. Once pages render per request that fetch
is a second copy of what the server just sent. `PromoStrip`, `HomeSections`,
`useLiveProduct` and `useLiveReviews` were all of this kind, and all of them are
gone — the server-rendered value is the live one.

The rest of the rule:

- **A hook that only writes does not read.** `useAddToCart` exists because the
  product page, the quick view and the wishlist only ever add to the bag;
  mounting the full `useCart` to get that one function cost a priced cart on
  each of those pages.
- **A badge asks for a number, not a document.** `useCartCount` takes the count
  from `useCart` when something on the page has already loaded the bag, and
  falls back to `GET /api/cart/count` — 54 bytes — when nothing has.
- **A count is counted in SQL.** The three portal sidebar badges were 459 KB of
  inventory, orders and reviews per page view; they are now
  `GET /api/admin/nav-counts`.
- **A filter goes in the query string.** See "Narrow reads for narrow
  questions" in the backend README for the list.
- **A resource that only a dialog uses loads when the dialog opens** — the
  `enabled` option on `useAdminResource`.
- **Wait for the session before asking.** `useCustomerStatus` distinguishes
  "signed out" from "not asked yet", so a page does not fire six requests
  against a token that has expired — nor, as the checkout did, mistake an
  unconfirmed session for a guest and bounce a signed-in shopper with a full
  bag back to /cart.

What deliberately stays: `GET /api/site/content` on the listing pages, because
the filter panel and the sort control genuinely need it and one 7.6 KB document
serves every caller on the page; and the portal's products and categories
tables, which read the catalogue in full because their filtering, sorting and
paging all happen in the browser. Making those server-driven would change how
the tables behave, which is a different change from this one.

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

Nothing on the sign-in page names an account, because there is no account to
name — the first person to register becomes the administrator, and after that
the credentials are theirs.

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

Razorpay, live. `PAYMENT_PROVIDER` picks the implementation — `razorpay` for the
real gateway, `mock` for a provider that moves no money and lets the whole order
flow be exercised without an account anywhere. Nothing above
`backend/app/services/payments/` names a gateway, so switching between them
changes no route, service or schema.

The backend README has the full account: the two-step checkout, what turns a
browser's claim into a settled payment, and why the webhook is the reliable
path. What matters on this side:

**Payment is the last step, and the page is ours.** Checkout runs Contact →
Delivery → Review → **Payment**, and the payment step is where the order is
created: choosing a method and pressing pay does both, in that order, in one
action. Every method is a panel of our own markup — `PaymentMethods.tsx` — with
no modal, no iframe and no other company's branding, driven by Razorpay's
Custom Checkout, which renders nothing and only exposes the rails. The shopper
authorises in their own bank's page or their own UPI app, which is the one step
that cannot happen anywhere else.

**The methods offered are the methods that will work.**
`GET /api/payments/methods` intersects what the store has switched on with what
the Razorpay account can actually take, and the page renders the result — so a
method a shopper picks is never one the gateway then refuses. UPI adapts to the
device: a phone gets app handoffs (Google Pay, PhonePe, Paytm, BHIM, Amazon
Pay), a computer gets a QR code and a UPI-ID request, because a `upi://` intent
on a laptop opens nothing.

**Nothing opens in a floating window.** Razorpay's Standard Checkout is given a
`parent` container, so the one frame that has to be theirs renders *inside* the
payment step rather than as a modal over the site — and a `config.display` block
limits it to cards alone, since every other rail is already a panel of ours.
`hide_topbar` and a matched backdrop take their chrome off it. The "Test Mode"
ribbon that used to sit over the page belonged to that modal and went with it.

**Scan to pay is in the page too.** A UPI QR is minted server-side through
Razorpay's QR Codes API and rendered in our own panel while the page polls for
the scan. No popup, nothing to type.

The code is **cut out of Razorpay's poster** before it is served. Theirs is a
tall poster with the code a third of the way down it between two rows of logos;
sized to fit a payment panel the modules end up too small for a camera and no
UPI app can read it. The backend README explains how the code is located. The
page then renders it at its natural size and never scales it down — a QR is a
grid of hard edges, and downscaling lands those edges between device pixels.

**Cards are the one exception, and it is a compliance one.** A card number
entered into our own markup would put PANs and CVVs in this application's
JavaScript, which moves the whole site from PCI-DSS SAQ-A to SAQ-D and is gated
behind a PCI certification on the gateway account. So the card panel uses the
processor's secure field and says so. Everything else — UPI, net banking,
wallets — passes only a bank code, a wallet name or a UPI address, none of them
a credential, and stays entirely in our interface.

**No payment credentials touch this application.** The card number, the UPI PIN
and the bank login are collected by Razorpay Checkout, inside Razorpay's own
iframe, on Razorpay's origin. `src/services/payments/razorpayCheckout.ts` loads
their script and receives three opaque references back — a field this code could
read is a field this code would be responsible for.

**The browser does not decide whether a payment succeeded.** It reports; the
server verifies the signature with the key secret, reads the payment back from
the gateway, and checks the amount against the invoice. `usePayment` reports
success only once the server has agreed.

**An unpaid order has five minutes.** Placing a prepaid order *holds* its
stock rather than taking it, and the payment page shows the time left. Dismissing
the payment sheet leaves the order open for the rest of that window, and
returning to it reopens the *same* gateway order rather than a new one. Once
the window closes the order is cancelled and the stock goes back on sale; a
payment that arrives after that is refunded, never used to revive the order.

**You must be signed in to check out.** A signed-out shopper who reaches any
checkout step is sent to sign in and brought back to that exact step. The `next`
parameter is checked by `src/lib/utils/safeRedirect.ts`, which accepts only a
path on this site, so the sign-in page cannot be used as an open redirect.

**The publishable key is served, not bundled.** `GET /api/payments/config`
hands over the key id, whether a gateway is live at all, and whether it is in
test or live mode. Rotating a key or going live is a restart of the API, not a
rebuild of the storefront — and the checkout notices and the terms page read
that mode rather than stating it, so a page cannot go on saying "no money
changes hands" after the live keys go in.

---

## Reorder, notifications, campaigns and backups

Reorder, multi-channel notifications (email, SMS, WhatsApp, in-app) with retries, the branded email templates, marketing campaigns and automated encrypted database backups are documented in [docs/messaging-and-backups.md](docs/messaging-and-backups.md) — architecture, provider set-up, environment variables, restore steps and tests.

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
| Roles | Assigned by the server on registration. The request cannot influence it |
| Production | Refuses to start with a default JWT secret, `DEBUG` on, wildcard CORS, the mock gateway, a test key, no webhook secret, or a non-https storefront URL |
| Stock | Checked and held under row locks at order time; a race for the last unit has exactly one winner |
| Payments | Signature, gateway read-back, amount and currency all checked; late, duplicate and stray payments refunded; webhook deliveries deduplicated |
| Migrations | Upgrade only. Nothing drops a table automatically |

---

## Tests

```bash
cd backend && pytest
```

400 tests against MySQL, in a database of their own. Money and tax arithmetic
against worked examples, password hashing and token forgery, registration and
sign-in, catalogue filtering and paging, the cart and its pricing, the
wishlist's uniqueness, the order transaction and what the client is not allowed
to decide, coupons, inventory and its ledger, refunds and credit notes, and —
endpoint by endpoint — who is allowed to call what. `test_payment_security.py`
covers the payment module's attacks: forged signatures, tampered prices and
quantities, replayed webhooks, late and duplicate payments, the five-minute
window, and two real connections racing for the last unit.

The frontend is checked with `npm run typecheck` and `npm run lint`.

---

## There is no demo data

There used to be: a fabricated catalogue of 140 products, 434 reviews, 66
customers and 176 orders with their invoices, payments and refunds — first as
JSON in the frontend bundle, then as JSON in the backend's seed folder,
reloaded on every boot. Along with the Node generators that produced it, the
seeder that read it, and the reset tool that dropped tables to re-run it.

All of it is gone. The catalogue is whatever somebody has added through the
portal, and a fresh database is empty.

The one thing a fresh install gets is **configuration**, because a store cannot
price anything without a currency or decide a tax treatment without a
registered state. It arrives once, from `backend/app/config_defaults/`,
installed by a migration that inserts only what is missing — so running it
against a configured store changes nothing. Every value in it has a screen in
the portal.

Initial state, installed once and then owned by the database, is not the same
thing as a dataset the application reads at runtime. The old seeder was the
second kind.

### Dummy images

Product photography is Unsplash URLs held on the product rows. To move to a real
CDN: change the URLs and add the host to `remotePatterns` in `next.config.ts`.
`ProductImage` falls back to an on-brand placeholder if a URL fails to load.

---

## What is deliberately not real

Honest about it in the UI rather than pretending:

- **The gateway mode follows the keys.** With `rzp_test_…` keys no real money
  moves; with `rzp_live_…` keys it does. The checkout notices and the terms page
  read the mode from the API rather than stating one of their own.
- **Fulfilment is yours.** Orders are real records with real stock movements
  and real invoices; shipping the parcel happens outside this application and is
  recorded from the portal.
- **Forms do not send.** The contact form and newsletter confirm and clear.
- **The tax figures are not a compliance calculation.** [Details](#tax).
- **There are no seeded accounts.** The first person to register is the
  administrator; nothing ships with a password.

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
