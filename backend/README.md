# Daily Choice Zone — backend

The API behind the storefront and the admin portal. FastAPI, SQLAlchemy 2, MySQL.

Everything the shop knows lives here: the catalogue, customers, carts,
wishlists, orders, invoices, payments, refunds, credit notes, coupons, reviews,
stock, and the configuration the portal edits. The frontend renders what this
tells it and decides none of it.

| | |
|---|---|
| Framework | FastAPI 0.115 · Uvicorn |
| ORM | SQLAlchemy 2.0 (typed `Mapped[...]`) · PyMySQL |
| Migrations | Alembic |
| Validation | Pydantic v2 · pydantic-settings |
| Auth | JWT (python-jose) · bcrypt via passlib |
| Tests | pytest, against a MySQL database of its own |

---

## Getting started

You need **Python 3.11+** and a **MySQL 8+** server running. Nothing else — the
database itself is created on first boot.

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # Windows: copy .env.example .env
python -m uvicorn app.main:app --reload
```

The first start creates the database and applies every migration. It prints
what it did. Then:

- API — <http://localhost:8000/api>
- Interactive docs — <http://localhost:8000/docs>
- Health check — <http://localhost:8000/health>

**Nothing is seeded.** A fresh installation has a configured store and an empty
catalogue: no products, no customers, no orders. That is what a real shop
starts as, and it is why every list the two applications render is editable
from the portal rather than compiled in.

### The first administrator

Nobody is created for you. **The first account to register becomes the
administrator**, and everyone who registers after them is an ordinary
customer.

So: start both servers, open the storefront, create an account. That account
can sign in to `/admin` as a super admin. The next person to register cannot.

The decision is made in `app/services/auth.py`, from the state of the
`admin_users` table, and **nothing in the request influences it** —
`RegisterRequest` has no role field to send, and a payload that invents one
changes nothing. It runs inside the registration transaction with a locking
read, so two people signing up at the same instant cannot both claim it: on an
empty table InnoDB takes a gap lock, the second request waits, and then sees
the administrator the first one created.

Being an administrator does not merge the two surfaces. One person, two
sessions: the token from `/auth/register` carries `actor: customer` and opens
no admin endpoint. The portal is reached by signing in to it, with the same
credentials.

## What happens at startup

Three steps, in order, before the first request is served — so a
misconfiguration is a startup failure with a readable message rather than a 500
somebody hits mid-checkout.

1. **Is MySQL reachable?** If not, it says so and what to check.
2. **Does the database exist?** `CREATE DATABASE IF NOT EXISTS` — never a drop.
3. **Is the schema current?** `alembic upgrade head`. Upgrade only: a process
   that runs unattended must not be able to destroy data.

**No data step.** Nothing is written at boot. The catalogue, the customers and
the orders are whatever the database holds; the configuration a fresh install
needs arrives once, from a migration.

Either of the first two can be switched off (`AUTO_CREATE_DATABASE`,
`AUTO_MIGRATE`), because a real deployment migrates from its own pipeline.

There is no tool that rebuilds the data, and deliberately so: the only thing
such a tool could rebuild is a demo dataset, and there is not one any more.
Dropping tables is `alembic downgrade` or a DBA, both of which are somebody
making an explicit decision rather than a convenience script sitting next to
the code.

---

## Layout

```
app/
  main.py              the FastAPI app: routers, CORS, error handlers
  core/
    config.py          settings from .env, and what production refuses to start without
    database.py        engine, session, first-run creation
    security.py        password hashing, JWT issue and verify
    permissions.py     what each admin role may write — the one copy
    errors.py          the error hierarchy and its handlers
    startup.py         the four steps above
  models/              32 tables, SQLAlchemy 2 declarative
  schemas/             Pydantic in and out — camelCase on the wire
  repositories/        the SQL that is complex enough to deserve a name
  services/            the business rules
  api/routes/          HTTP only: read the request, call a service, wrap the result
  dependencies/        who is calling, and what they may do
  config_defaults/     the configuration a fresh install starts with, once
  utils/               id generation, the response envelope
tests/
  unit/                money, tax, tokens — no database
  integration/         the API and the database together
```

### The layering, and why

```
Route  →  Schema  →  Service  →  Repository  →  Model
```

A **route** does HTTP and nothing else. A **schema** decides whether the request
is even coherent. A **service** holds the rules — this is where "can this be
refunded" lives. A **repository** holds queries too involved to leave inline. A
**model** is the table.

The rule that keeps it honest: a route never touches a model, and a service
never touches a `Request`. When a rule lives in a route it exists once, for one
endpoint; when it lives in a service it exists for every caller, including the
next one.

---

## Conventions

### One envelope

```jsonc
{ "success": true,  "data": { }, "message": "Signed in." }
{ "success": true,  "data": [ ], "pagination": { "page": 1, "page_size": 24, "total": 139, "total_pages": 6 } }
{ "success": false, "message": "That coupon has expired.", "error_code": "COUPON_INVALID" }
```

Always the same shape, including on failure, so the client has one thing to
unwrap. `error_code` is what to branch on — matching on `message` is a contract
nobody agreed to.

### Ids people can read

`PRD001`, `CUS001`, `ORD001`, `INV001`, `PAY001`, `CAT001`, `COL001`, `CPN001`,
`REV001`, `RFN001`, `CRN001`, `ADM001`, `ADR001`, `BNR001`.

One prefix per entity, three digits, growing past it without a format change —
`PRD1000` simply follows `PRD999`. `GET /api/products/PRD001` works, and so does
reading a support ticket that quotes one.

The width is decided in exactly one place (`app/utils/ids.py`). It has to be:
back when there was a seeder, it padded invoices to four digits and the id
generator to three — the two series interleaved, and the first order placed
after a seed collided with an existing invoice.

### The configuration documents

Seven rows in `setting_documents`, each a whole JSON document:

| Key | What it holds |
|---|---|
| `store` | store settings — contact details, shipping fees, returns window |
| `billing` | seller details, currency, numbering, refund reasons, enabled payment methods |
| `tax` | GST registration and rates |
| `site` | brand, support details, social links, trust points, footer |
| `content` | the lists the two applications render — see below |
| `navigation` | the storefront menu |
| `admin_navigation` | the portal sidebar |

Each has a screen in the portal:

| Screen | Documents |
|---|---|
| Settings | `store` |
| Settings → Site | `site` |
| Settings → Content | `content` |
| Settings → Navigation | `navigation`, `admin_navigation` |
| Settings → Billing | `billing`, `tax` |

A save is **merged at the top level**, not stored as the whole document. This is
not tidiness. The billing screen does not model the `order` and `sku` sections —
they are numbering prefixes, not settings anyone edits there — so a replacing
save deleted them. Order numbering then fell back to its starting number on
every order, and the second order asked the unique index for a number the first
one already had: checkout returned a 409 from then on. A screen that *sends* a
section still owns it, so removing a refund reason or a payment method works as
before. `tests/integration/test_numbering_and_settings.py` holds both rules.

`content` is the one worth naming. It holds the states a delivery address can
choose, the contact form's topics, the popular searches, the sort orders, the
rating and discount filter buckets, the delivery and payment methods, the FAQ,
the size charts, the account menu, and the vocabularies behind every dropdown
in the portal — roles, stock adjustment reasons, analytics ranges and homepage
section kinds.

Every one of those was an array in a frontend component or service. They are
rows now, read through `GET /api/site/content`, so changing one is an edit to
the store rather than a deployment. Two things deliberately did **not** move:
which icon a named menu entry draws, because an API cannot send a React
component, and `app/core/permissions.py`, because what a role may *write* is
policy this server enforces — put it in an editable document and an
administrator could grant themselves the right to grant permissions.

### camelCase on the wire, snake_case in Python

Schemas carry an alias generator, so the API speaks the frontend's TypeScript
shapes and the Python stays Python. No mapping layer, and nothing to keep in
sync.

### Money is an integer

Every billing amount is an integer in the currency's minor unit — paise. Never a
float. `0.1 + 0.2` is not `0.3` in binary floating point, and a rounding error
of a hundredth of a rupee per line becomes an invoice that does not add up.

The catalogue still prices in whole rupees because that is what it sells in;
`to_minor` is the boundary, and it goes through `Decimal`.

### No duplicate endpoints

One resource, one route, and filters rather than variants. `GET /api/products`
answers "new arrivals" (`?isNew=true`), "trending", "under ₹2000" and "sorted by
price" — because five endpoints returning products is five places to fix a bug.

Updates are payload-driven: `PUT /api/products/{id}` applies whatever the body
contains and leaves the rest alone.

### Narrow reads for narrow questions

The counterpart to the rule above: a filter belongs on the server. A screen that
wants one row, or eight, or a single number must not read the table and do the
work in the browser — that is the same query, run in the slowest possible place,
over the wire.

Every one of these replaced exactly that:

| Route | What asks for it | Instead of |
|---|---|---|
| `GET /api/cart/count` | the header bag badge | the whole priced cart, per page |
| `GET /api/admin/nav-counts` | the three sidebar badges | the inventory, the orders and the reviews in full — 459 KB a page view |
| `GET /api/admin/billing/overview` | the billing landing page's three panels | every invoice, payment and refund — 468 KB, to show eight rows |
| `?orderId=` on `billing/invoices`, `billing/payments`, `billing/credit-notes` | the order and invoice screens | the whole ledger, then `.find()` |
| `?customerId=` on `admin/orders` | the customer screen | every order in the shop — 279 KB |

`GET /api/admin/dashboard` already returned its recent orders and low-stock
rows; the page was throwing them away and reading `admin/orders` and
`admin/inventory` for the same thing.

The test that matters for each is not that it is smaller but that it is the
*same answer* — see `tests/integration/test_narrow_reads.py`, which compares
each narrow read against the wide one it replaced.

---

## Security

These are not aspirations; they are properties the tests assert.

**Passwords** are bcrypt hashes with a per-hash salt. There is no plaintext
column. A password longer than bcrypt's 72-byte limit is *refused*, not silently
truncated — accepting it would mean two different passwords that both open the
account.

**Tokens** carry an `actor` claim (`customer` or `admin`). It is checked on
every request, not just the signature: an administrator's token is a valid
token, and without that check it would satisfy a customer endpoint and read
somebody else's cart. It works both ways, and both directions are tested against
every endpoint.

**Authorisation is enforced here.** The portal hides buttons a role cannot use,
which is a courtesy to the person using it. `require_permission` is the
boundary.

**Nothing the client says about money is trusted.** Price, discount, coupon,
tax, shipping, total and payment status are all recalculated from the cart and
the catalogue at the moment the order is placed. A payload that names its own
total changes nothing — there is a test called exactly that.

**No payment secrets reach the browser.** Creating a payment, verifying a
signature and handling a webhook are secret-key operations and all of them live
in `app/services/payments/`. The frontend never names a gateway.

**No card data is stored anywhere.** The only payment detail kept is a masked
`instrument_hint` of the kind a gateway returns *after* processing. No card
number, expiry, CVV, UPI PIN or bank credential is collected, stored or
transmitted, and none may be added — real card entry belongs in the provider's
own hosted fields.

**Errors say what went wrong, not how.** A driver message or a stack trace
describes your schema to whoever asked for it. Database errors are logged in
full and returned as a generic message with a code.

**Roles are assigned by the server.** The first registration on an empty
installation becomes the administrator; every one after it is a customer.
Nothing in the request influences that — see [The first administrator](#the-first-administrator).

**Production refuses to start** with the default JWT secret, `DEBUG` on, or a
wildcard CORS origin. It lists every problem rather than failing on the first.

**Migrations only ever upgrade.** Nothing drops a table automatically, and
nothing in the codebase can — the tool that used to is gone along with the
demo data it existed to reload.

---

## Payments

`PaymentProvider` is an interface with four methods — `create`, `verify`,
`fetch` and `refund` — and `PAYMENT_PROVIDER` picks the implementation. Two
exist:

| `PAYMENT_PROVIDER` | What it does |
|---|---|
| `mock` | Moves no money, contacts nothing, returns believable references. Lets the whole order flow be exercised without an account anywhere. Refuses to construct when `ENVIRONMENT=production`. |
| `razorpay` | The real thing. Test keys and live keys take the same code path. |

Nothing above that layer names a gateway, so switching between them changes no
route, service or schema. Adding Cashfree, PayU or Stripe is one more class in
`app/services/payments/` and one environment variable.

### Checkout is two steps, because a gateway makes it two

With `mock`, `POST /api/orders` is the whole of checkout: the payment settles
synchronously and the order is confirmed before the response is written. A real
gateway cannot work that way, because the shopper has to be shown a payment
screen and the order has to exist before there is anything to pay for.

So:

```
POST /api/orders               order + invoice + payment, order held `pending`
      ↓ returns a gateway handoff
Razorpay Checkout              in the browser, on Razorpay's origin
      ↓ returns three references
POST /api/payments/{id}/verify signature checked, gateway read back, order confirmed
```

An order awaiting a gateway stays at status `pending` and is confirmed by
settlement. Confirming it at creation would mean an abandoned payment screen
left behind a confirmed order nobody ever paid for.

`GET /api/payments/{id}/session` re-opens the **same** gateway order for a
payment that was left unpaid — two open gateway orders against one invoice is
how a customer gets charged twice.

### What the payment page may offer

`GET /api/payments/methods` intersects two lists: the methods the store has
switched on in the billing document, and the ones `Razorpay.methods()` reports
the account can take. Only the intersection is offered.

This matters because the two disagree silently. A method switched on in our own
settings but off in the Razorpay account fails at the payment screen, *after*
the shopper has chosen it — and an account can be subtler than on/off: this one
has `upi: false` with `upi_intent: true`, meaning it can hand off to a UPI app
but cannot produce a QR code or a collect request. The endpoint reports both
flags separately so the page can offer app handoffs on a phone and say plainly
that a QR is unavailable.

`cod` is exempt: it is an arrangement with a courier, not a gateway rail, so it
comes from the store's settings alone.

### Scan to pay is a different product

`POST /api/payments/{id}/qr` mints a UPI QR code through Razorpay's **QR Codes**
API, which is enabled separately from Checkout's `upi` method — an account can
have one without the other. That is why the payment page can offer scan-to-pay
on a Checkout-UPI-disabled account, and why `qrCodes` is reported on its own
footing rather than behind the `upi` flag.

The code is `single_use` and `fixed_amount`, so it is worth exactly this invoice,
once. A reusable code for a variable amount is a code that can be scanned again
tomorrow.

### The code has to be cut out of their poster

Razorpay serves exactly one image per code, and it is not a QR code: it is a
674×1644 **poster** with a 378px code a third of the way down it, under a
"Powered by Razorpay" banner, between BHIM/UPI marks and GPay/PhonePe/Paytm
logos, above the merchant's name. Every documented and undocumented query
parameter returns the same PNG.

Shown in a square payment panel, that poster shrinks the code to about a fifth
of its real size and squashes it out of square — and **no UPI app can read it**.
The failure is silent, because the page still shows an image.

So `app/services/payments/qr_image.py` locates the code inside the poster and
`GET /api/payments/qr-image/{qr_id}` serves that square alone: bitonal, with a
quiet zone pasted on rather than cropped in, about 2 KB instead of 396 KB.

It *measures* rather than assuming a rectangle, because a hard-coded crop is a
guess about someone else's template that breaks silently. Near-black and
unsaturated pixels only — the artwork is a saturated blue dark enough to pass a
brightness test and it spans the full width — then the dense column span for the
width, then the row run whose height matches it, since a QR is square and the
logo strip is not. No square run means no code, and the poster is returned
whole: worse than a bare code, far better than a broken image.

That route is the one payment route with no session behind it. An `<img src>`
cannot carry an `Authorization` header, and Razorpay serves the same poster on
an unauthenticated URL of its own — so the code's id is the secret either way,
and the route is keyed on the code alone and reveals no order or customer.

The consequence to understand is that **a QR payment is not attached to a
gateway order**. Scanning produces a payment of its own, so it cannot be settled
by the order signature the card and net banking flows use. Two things bind it
back instead, and both are checked:

- the code is minted with `notes.paymentId`, and a scan whose notes name a
  different payment is refused;
- the payment must have **captured**, read from the gateway with the secret key.

It settles two ways for the same reason every other rail does: `GET
/api/payments/{id}/qr/{qr_id}` is polled while the code is on screen so the page
moves the moment somebody pays, and the `qr_code.credited` webhook settles it
when they close the tab instead. `DELETE` on the same path retires a code nobody
used.

### What makes a payment real

A browser saying "this succeeded" is a claim. Four things turn it into a fact,
and all four are in `app/services/settlement.py` and the Razorpay provider:

1. **The signature.** `HMAC-SHA256("{order_id}|{payment_id}")` under the key
   secret. Only Razorpay and this process know that secret.
2. **The order must be ours.** The order id the signature is checked against
   comes from our own payment record, never from the request — otherwise a real
   signature for a cheaper order of one's own would settle an expensive one.
3. **A read back from the gateway.** A valid signature says the payment belongs
   to the order. It says nothing about whether it succeeded.
4. **The amount must match the invoice.** A payment that verifies for the wrong
   amount is not a paid order.

### The webhook is the reliable path

`POST /api/payments/webhook/razorpay`, subscribed to `payment.captured`,
`payment.authorized`, `payment.failed`, `order.paid`, `qr_code.credited`,
`payment_link.paid`, `refund.processed` and `refund.failed`.

Each delivery's `x-razorpay-event-id` is recorded in `webhook_events`, so a
redelivery is acknowledged without being applied twice. Body size is capped at
256 KB before the signature is even computed.

The browser's verify call is what makes the confirmation page correct
immediately. The webhook is what makes the order correct when the shopper pays
and then closes the tab. Both settle the same payment on purpose, and
`settlement` is idempotent so whichever arrives first wins and the other is a
no-op — Razorpay retries deliveries and may send one twice.

Two rules there are easy to get wrong:

- **The signature is over the raw bytes.** Re-serialising the JSON changes the
  digest, so the route reads `await request.body()` and verifies before parsing.
- **An unknown event still answers 200.** Anything that is not 2xx is
  redelivered on a schedule for days. A bad *signature* is refused, because an
  endpoint that marks orders paid on unverified input is an open door — and with
  `RAZOR_WEBHOOK_SECRET` unset, every delivery is refused.

### Stock is held, not taken, while a customer pays

A prepaid order does not take its stock at creation; it **reserves** it —
`products.reserved_stock` rises and `available = stock − reserved_stock` falls,
so nobody else can buy the last unit while somebody is on the payment screen.
`orders.stock_state` records which it is: `reserved`, `consumed` or `released`.

- **Paid in time** → the reservation is committed: stock falls, the hold is
  cleared, the order is confirmed.
- **Not paid within `PAYMENT_WINDOW_SECONDS` (5 minutes)** → after a
  `PAYMENT_GRACE_SECONDS` grace for payments already in flight, the sweeper in
  `app/services/payment_expiry.py` cancels the order and releases the hold. The
  session endpoint also expires a lapsed order the moment anyone asks for it,
  so correctness does not depend on the sweeper's timing.
- **Paid after that** → never confirms the cancelled order. `_apply_paid`
  sees the lapsed window and refunds the payment in full, with a timeline note.

The gateway is told about the window too: Checkout is opened with `timeout`
set to the seconds left, and a QR code with `close_by`, so neither will take
money for an order that has already closed.

Every stock change runs under `SELECT … FOR UPDATE` on the product rows, taken
in id order so two checkouts cannot deadlock. The locking select uses
`populate_existing` — without it SQLAlchemy returns the copy of the product it
already loaded for the cart, stale by exactly the purchase that happened in
between, and two buyers can both have the last unit.
`tests/integration/test_payment_security.py::TestConcurrency` races two real
connections for one unit and fails if both succeed.

Cash-on-delivery orders consume stock immediately, as before; there is nothing
to wait for.

### Duplicates, stray payments and refunds

- A second payment against an order that is already paid is **refunded**, not
  kept: a customer who paid twice from two tabs is repaid automatically.
- Settlement is idempotent: the browser's verify, the poll and the webhook can
  all arrive, in any order, and exactly one of them settles the order.
- Amount **and currency** must match the invoice.
- Refunds are asynchronous at Razorpay. A refund Razorpay accepts is recorded
  as `processing`; `refund.processed` completes it and `refund.failed`
  reverses it, restoring the payment's refundable balance.
- Cancelling a paid order releases its stock and refunds the payment.

### Payment Links, for cash on delivery

`POST /api/admin/orders/{id}/payment-link` (the order detail page's **Send
payment link** button) asks Razorpay to text and email the customer a link to
pay a confirmed, unpaid **cash-on-delivery** order now instead of in cash. It
lives 24 hours. The order is marked paid only when the gateway confirms it —
through the signed redirect to `GET /api/payments/link-callback` or the
`payment_link.paid` webhook — never when the link is sent.

Not offered at checkout, deliberately: Razorpay requires a link to live at
least fifteen minutes, and a checkout hold lasts five. A link for a checkout
order would be a guaranteed late payment.

### Going live: what the API refuses

With `ENVIRONMENT=production`, `validate_production()` stops the API from
starting unless all of these hold:

- `PAYMENT_PROVIDER=razorpay`, with a key id starting `rzp_live_` and its secret
- `RAZOR_WEBHOOK_SECRET` set
- `STOREFRONT_URL` is `https://`
- a JWT secret that is not the default, `DEBUG=false`, no wildcard CORS

A misconfigured store that fails to start is a better outcome than one that
takes orders without taking money.

### Secrets

`RAZOR_KEY_ID` is publishable and is served to the browser by
`GET /api/payments/config`; Razorpay Checkout cannot open without it, and on its
own it can only start a payment. `RAZOR_KEY_SECRET` and `RAZOR_WEBHOOK_SECRET`
can take money and never leave this process. Neither has a `NEXT_PUBLIC_`
counterpart and neither may be given one.

### References on a payment record

`transaction_id` holds the gateway's **order** id until a payment exists, then
becomes the **payment** id — which is the reference a refund is issued against.
The order id moves to `provider_reference`, because the signature is computed
over it. A webhook may arrive either side of that swap, so both columns are
searched when one is matched.

### Testing it

`tests/integration/test_payments_razorpay.py` covers all of the above against a
stubbed transport — no network, so the suite does not depend on Razorpay's
uptime. The signature checks themselves are not stubbed: a test that faked an
HMAC would be testing nothing.

An autouse fixture forces `mock` for the whole suite even when `.env` names a
real provider, so a test run never opens gateway orders in a live account.

---

## Tax

Indian GST, configurable, stored as a settings document the portal can edit.

Supply inside the seller's own state is split into CGST and SGST; supply across
a state line is a single integrated tax. Which applies is decided by the
**billing** address against `originState`, per line, because rates vary by
category and an invoice has to show the tax against each item.

Prices are tax-inclusive by default, so the tax is *extracted* rather than
added — the customer pays what the shelf said and the invoice shows how that
splits. CGST and SGST are each half of the *total*, not half of the rate, so the
two halves always reconcile with the whole.

An order-level coupon is apportioned across lines before tax, by value, using a
largest-remainder allocation that sums back exactly. Without that, the line
taxes would not reconcile with the invoice total — the error an auditor finds
first.

**Scope, stated plainly:** this is a configurable representation of GST, not a
compliance implementation. Real treatment depends on HSN classification,
exemptions and thresholds, reverse charge and place-of-supply rules that belong
with professional advice.

---

## Tests

```bash
pytest                    # everything
pytest tests/unit         # no database
pytest -m integration     # the API and the database together
pytest -k refund          # by name
```

400 tests. They run against MySQL in a database of their own
(`daily_choice_zone_test`, or `TEST_DATABASE_NAME`), created on first run and
rebuilt from the models each session. The development database is never touched
— the fixtures refuse to run if the two names coincide.

Each test runs inside a transaction that is rolled back afterwards, so tests see
their fixtures and nothing any other test wrote.

The fixtures are small and written in `conftest.py`: four products, two
customers, one administrator. A test that asserts on "the 47th product" is a
test nobody can read.

What is covered: money and tax arithmetic against worked examples, password
hashing and token forgery, registration and sign-in, catalogue filtering,
sorting and paging, the cart and its pricing, the wishlist's uniqueness, the
order transaction and what the client is not allowed to decide, coupons,
inventory and its ledger, refunds and credit notes, order numbering and what a
configuration save may not delete, the narrow reads above against the wide ones
they replaced, the Razorpay flow end to end including every way a payment can
fail to verify, and — endpoint by endpoint — who is allowed to call what.

---

## Reorder, notifications, campaigns and backups

Reorder, multi-channel notifications (email, SMS, WhatsApp, in-app) with retries, the branded email templates, marketing campaigns and automated encrypted database backups are documented in [docs/messaging-and-backups.md](../docs/messaging-and-backups.md) — architecture, provider set-up, environment variables, restore steps and tests.

## Configuration

Everything is read from `.env`; `.env.example` lists it all. Nothing is
hardcoded, and none of it reaches the frontend.

| Variable | Default | |
|---|---|---|
| `DATABASE_HOST` / `PORT` / `USER` / `PASSWORD` / `NAME` | `localhost` `3306` `root` `root` `daily_choice_zone` | |
| `DATABASE_ECHO` | `false` | Log every statement. Deafening in production |
| `JWT_SECRET_KEY` | `change-this-secret` | **Production will not start with this value** |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `60` | |
| `ENVIRONMENT` / `DEBUG` | `development` / `true` | |
| `CORS_ORIGINS` | `http://localhost:3000,…` | A list, never `*` |
| `AUTO_CREATE_DATABASE` / `AUTO_MIGRATE` | `true` | Either step of startup, independently |
| `PAYMENT_PROVIDER` | `mock` | Which `PaymentProvider` to use |

---

## There is no demo data

There used to be: `app/seed/` held a fabricated catalogue — 140 products, 434
reviews, 66 customers, 176 orders with their invoices, payments and refunds —
as JSON, reloaded on every boot, plus the Node generators that produced it.
All of it is gone, along with the seeder and the reset tool that dropped tables
to re-run it.

What replaced it is nothing at all. The catalogue is whatever somebody has
added through the portal. A fresh database is empty, and the first person to
register is the administrator who fills it.

The one thing a fresh install *does* get is configuration, because a store
cannot price anything without a currency or decide a tax treatment without a
registered state. That arrives once, from `app/config_defaults/`, installed by
the `configuration baseline` migration:

- **Insert-if-absent, never update.** Running it against a configured store
  changes nothing.
- **Read once, at migration time.** Nothing in `app/` imports it afterwards;
  the database is the only source the application reads.
- **Editable from the portal.** Every value in it has a screen — see the
  document table above.

That is the difference worth holding on to. Initial state that is installed
once and then owned by the database is not the same thing as a dataset the
application reads at runtime, and the old seeder was the second kind.
