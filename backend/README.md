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
`fetch` and `refund` — and `PAYMENT_PROVIDER` picks the implementation.

The one that ships is `mock`: it moves no money and returns believable
transaction ids, which is what lets the whole order flow be exercised without an
account anywhere. Adding Razorpay, Cashfree, PayU or Stripe means writing one
class in `app/services/payments/` and changing one environment variable.
Nothing above that layer names a gateway, so nothing above it changes.

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

294 tests. They run against MySQL in a database of their own
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
they replaced, and — endpoint by endpoint — who is allowed to call what.

---

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
