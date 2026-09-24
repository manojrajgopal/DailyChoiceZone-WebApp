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

The first start creates the database, applies every migration and loads the
demo data. It prints what it did. Then:

- API — <http://localhost:8000/api>
- Interactive docs — <http://localhost:8000/docs>
- Health check — <http://localhost:8000/health>

### Demo accounts

Seeded with hashed passwords, like any other account. There is no plaintext
password column for them to live in.

| | Email | Password |
|---|---|---|
| Administrator | `admin@dailychoicezone.com` | `Admin@123` |
| Customer | any seeded customer, e.g. `aditya.banerjee1@example.com` | `Customer@123` |

Change them before this is in front of anybody. Seeding is refused outright in
production (`AUTO_SEED` must be off, and the app will not start otherwise).

---

## What happens at startup

Four steps, in order, before the first request is served — so a
misconfiguration is a startup failure with a readable message rather than a 500
somebody hits mid-checkout.

1. **Is MySQL reachable?** If not, it says so and what to check.
2. **Does the database exist?** `CREATE DATABASE IF NOT EXISTS` — never a drop.
3. **Is the schema current?** `alembic upgrade head`. Upgrade only: a process
   that runs unattended must not be able to destroy data.
4. **Is the demo data loaded?** Seeded **if absent**, by primary key. A restart
   neither duplicates anything nor overwrites a change made through the portal.

Each step has its own switch (`AUTO_CREATE_DATABASE`, `AUTO_MIGRATE`,
`AUTO_SEED`), because a real deployment migrates from its own pipeline and must
never seed.

To rebuild the development database from scratch — after changing the seed's
shape, say — there is a deliberate, manual tool:

```bash
python -m app.seed.reset --yes
```

Nothing calls it. It refuses to run unless `DEBUG` is on and the database is the
development one.

---

## Layout

```
app/
  main.py              the FastAPI app: routers, CORS, error handlers
  core/
    config.py          settings from .env, and what production refuses to start without
    database.py        engine, session, first-run creation
    security.py        password hashing, JWT issue and verify
    errors.py          the error hierarchy and its handlers
    startup.py         the four steps above
  models/              32 tables, SQLAlchemy 2 declarative
  schemas/             Pydantic in and out — camelCase on the wire
  repositories/        the SQL that is complex enough to deserve a name
  services/            the business rules
  api/routes/          HTTP only: read the request, call a service, wrap the result
  dependencies/        who is calling, and what they may do
  seed/                the demo data, its id translation, and the reset tool
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
when the seeder padded invoices to four digits and the id generator to three,
the two series interleaved and the first order placed after a seed collided with
a seeded invoice.

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

**Production refuses to start** with the default JWT secret, `DEBUG` on, a
wildcard CORS origin, or `AUTO_SEED` left on. It lists every problem rather than
failing on the first.

**Migrations only ever upgrade.** Nothing drops a table automatically. The one
tool that can is manual, guarded, and called by nothing.

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

258 tests. They run against MySQL in a database of their own
(`daily_choice_zone_test`, or `TEST_DATABASE_NAME`), created on first run and
rebuilt from the models each session. The development database is never touched
— the fixtures refuse to run if the two names coincide.

Each test runs inside a transaction that is rolled back afterwards, so tests see
their fixtures and nothing any other test wrote.

The fixtures are small and written in `conftest.py` rather than loaded from the
demo seed: a test that asserts on "the 47th product" is a test nobody can read,
and a fixture set that changes when the demo data is regenerated is a suite that
breaks for no reason.

What is covered: money and tax arithmetic against worked examples, password
hashing and token forgery, registration and sign-in, catalogue filtering,
sorting and paging, the cart and its pricing, the wishlist's uniqueness, the
order transaction and what the client is not allowed to decide, coupons,
inventory and its ledger, refunds and credit notes, and — endpoint by endpoint —
who is allowed to call what.

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
| `AUTO_CREATE_DATABASE` / `AUTO_MIGRATE` / `AUTO_SEED` | `true` | Each step of startup, independently |
| `PAYMENT_PROVIDER` | `mock` | Which `PaymentProvider` to use |

---

## The demo data

`app/seed/data/` holds the JSON the seed is built from — 139 products, 434
reviews, 64 customers, 168 orders with their invoices, payments, refunds and
credit notes. It used to live in the frontend bundle; it lives here now because
it is *seed* data, and the browser has no business shipping it.

The generators that produce it are in `app/seed/generators/`, and
`node app/seed/generators/check-data.mjs` validates the lot — every reference
resolves, every invoice total re-derives from its components.

The demo ids (`prod_001`, `order_0005`) are translated to the `PRD001` scheme on
the way in, and **every reference between records is translated with them**.
Renumbering without rewriting the references would leave a database full of
dangling pointers.
