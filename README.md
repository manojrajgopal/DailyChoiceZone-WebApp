# Daily Choice Zone — storefront & admin portal

The frontend for Daily Choice Zone. **Quality products, happier you.**

Two applications in one codebase: the customer storefront at `/`, and an
administration portal at `/admin` that manages the same catalogue.

| | |
|---|---|
| Framework | Next.js 16 (App Router) · React 19 · TypeScript (strict) |
| Styling | Tailwind CSS v4, CSS-first tokens |
| State | Zustand (+ `persist` for local storage) |
| Data | Local JSON behind a service layer — **no backend yet** |
| Output | Fully static (`output: "export"`) — deploys to any static host |

There is no backend. Every product, category, collection, coupon and page of
copy comes from JSON in `src/data`, read through a service layer that is shaped
like the REST API that will eventually replace it. Swapping to that API is a
configuration change, not a rewrite — see
[Connecting a backend](#connecting-a-backend).

The admin portal writes through the same layer, keeping its changes in local
storage. **It is a demonstration, not a secured application** — see
[Admin portal](#admin-portal) before putting it anywhere public.

---

## Getting started

```bash
cd frontend
npm install
npm run dev
```

Then open <http://localhost:3000>.

| Script | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Static export to `out/` (prerenders every page, storefront and admin) |
| `npm run start` | Serve on Node — only if you drop `output: "export"` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run data:generate` | Regenerate the dummy catalogue (see [Data](#data)) |
| `npm run data:admin` | Regenerate the admin dummy data (orders, customers, analytics) |
| `npm run data:check` | Validate `src/data` — run this after hand-editing the JSON |
| `npm run brand:assets` | Regenerate sized logo assets from `assets/logo-original.png` |

### Environment variables

All optional. Nothing is required to run the store.

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_DATA_SOURCE` | `mock` | `http` switches the whole store onto the REST API |
| `NEXT_PUBLIC_API_URL` | — | Base URL for that API |
| `NEXT_PUBLIC_MOCK_LATENCY` | `0` | Artificial delay in ms, to make loading skeletons visible while working on them |

---

## Deploying

The build is a static export, so it needs no server at request time.

### Render (Static Site)

| Field | Value |
|---|---|
| Root Directory | `frontend` |
| Build Command | `npm ci && npm run build` |
| Publish Directory | `out` |

Environment variables are optional — `mock` is already the default data source.
`NEXT_PUBLIC_*` values are inlined at **build** time, so changing one needs a
redeploy rather than a restart.

### What `output: "export"` costs, and how the code pays for it

Static hosting means nothing runs per request. Four consequences are handled
explicitly, and are worth knowing before adding a feature that assumes a
server:

- **Nothing can read a request.** `/search` and `/account/order` take their
  input from the query string *in the browser* (`useSearchParams`), not from
  server-side `searchParams`. An order number is `?number=` rather than a path
  segment, because a dynamic segment needs every possible value known at build
  time.
- **No image optimizer.** `images.unoptimized` is required, so `next/image`
  serves the source file untouched. That is why `npm run brand:assets` exists:
  the master logo is 1.3MB and the header renders it at 44px. Product
  photography is already sized through Unsplash URL parameters.
- **Nothing is per-request, including the clock.** Anything date-dependent runs
  in the browser — see `CopyrightYear` and the arrival estimate in
  `ProductPurchasePanel`. A date computed during render would freeze at build
  time and mismatch on hydration.
- **Prefetch filenames need reconciling.** Next 16 writes route-segment
  prefetch payloads as nested directories but requests them with dot-joined
  names, which 404s on a static host. `scripts/flatten-prefetch.mjs` renames
  them and runs automatically as `postbuild`. Delete it if a future Next
  release fixes the mismatch.

`out/` is roughly 96MB, mostly the 139 prerendered product pages and their
prefetch payloads. That is deploy weight only; hosts serve these compressed.

### Moving to a Node deployment

To get image optimization and server rendering back, remove `output: "export"`,
`trailingSlash` and `images.unoptimized` from `next.config.ts`, then deploy as
a Render **Web Service** with build `npm ci && npm run build` and start
`npm start`. The query-param routes keep working unchanged.

---

## Architecture

Data flows one way, and each layer only knows about the one below it:

```
src/data/*.json          ← today's source of truth
        ↓
services/adapters/       ← the ONLY place that knows where data comes from
        ↓
services/*Service.ts     ← named business intentions (getNewArrivals, applyCoupon)
        ↓
hooks/                   ← React state, loading and error handling
        ↓
components/              ← presentation
        ↓
app/                     ← routes and metadata
```

The rule that keeps this honest: **no component imports JSON, and no component
imports an adapter.** Components call services (or hooks that call services).
That is what makes the backend swap a one-file change.

```
src/
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
│   └── admin/            the portal: layout, ui, charts, views
├── data/                 products, categories, collections, navigation, config
│   └── admin/            orders, customers, analytics, product metadata, settings
├── services/             the data-access layer
│   ├── data-source.ts            the contract
│   ├── data-source.instance.ts   which adapter is active
│   ├── adapters/                 mock-adapter.ts, http-adapter.ts
│   └── admin/            the portal's own services + AdminDataSource contract
├── hooks/                useCart, useWishlist, useProducts, useProductQuery, …
├── store/                cart, wishlist, session, checkout, recently viewed, toasts
├── lib/                  filters, recommendations, formatting, storage
│   └── admin/            the shared catalogue join and the mock write store
└── types/                the domain model (+ admin.ts)
```

### Things worth knowing before you change something

**Filters live in the URL, not in component state.** `useProductQuery` reads and
writes the query string, so a filtered view is shareable, bookmarkable and
correctly undone by the browser back button. `/shop`, every category page and
search are all the same `ProductListing` component with a different `basePath`.

**The homepage is data.** `src/data/homepage.json` lists its sections in order.
Reorder a rail, retitle it, change how many products it shows or drop it
entirely by editing that file — `app/page.tsx` never changes. Adding a new *kind*
of section means adding a case to `components/home/HomeSectionRenderer.tsx`.

**Navigation is data.** `src/data/navigation.json` drives the desktop mega menu
and the mobile drawer from the same structure. The portal's sidebar works the
same way, from `src/data/admin/navigation.json`.

**Route groups keep the two applications apart.** `app/(storefront)/` carries
the customer header, promo strip and footer; `app/admin/(portal)/` carries the
portal's sidebar and top bar. Neither layout can leak into the other, and the
URLs are unaffected. The root layout holds only the document itself.

**The cart and wishlist store ids, never products.** Prices and stock are
re-read from the catalogue on every render, so a bag that has sat in local
storage for a month still shows today's prices. All money arithmetic lives in
`services/cartService.ts` and is pure and synchronous, so totals update the
instant a quantity changes.

**Local storage is always guarded.** `lib/storage/local-storage.ts` wraps every
access, because local storage throws in private browsing and when a user blocks
site data. A storefront must not white-screen because someone tightened their
browser settings.

**Anything driven by local storage waits for hydration.** The cart badge,
wishlist hearts and recently viewed all render their empty state on the server
and fill in on the next paint, via `useHydrated`. Checkout's step guards use
`useCheckoutHydrated` instead, which waits for zustand to actually rehydrate —
otherwise refreshing the payment step would bounce you back to step one.

---

## Data

`src/data/` is the source of truth. The catalogue and reviews are produced by
`scripts/generate-products.mjs`, which exists so ids and slugs are unique,
derived fields stay consistent, and collections can never reference a product
that does not exist. Output is deterministic — every value is seeded from a hash
of the product slug, so re-running it produces no diff churn.

```bash
npm run data:generate
```

| File | Notes |
|---|---|
| `products.json` | 139 products across 11 categories. **Generated** |
| `reviews.json` | ~430 reviews. **Generated** |
| `collections.json` | Curated membership lists. **Generated**, then hand-edit |
| `categories.json` | Departments and their subcategories |
| `navigation.json` | Header mega menu and mobile drawer |
| `homepage.json` | Homepage composition |
| `site-config.json` | Brand, support details, delivery thresholds, footer |
| `coupons.json` | Discount codes |

The portal's data lives in `src/data/admin/`, produced by
`scripts/generate-admin-data.mjs` (`npm run data:admin`). It is generated *after*
the catalogue and references it, so every order line points at a product that
exists:

| File | Notes |
|---|---|
| `product-meta.json` | Management fields, joined to `products.json` by id |
| `orders.json` | 168 orders with line items and an append-only timeline |
| `customers.json` | 64 customers, their totals derived from those orders |
| `analytics.json` | Pre-aggregated ranges for the dashboard and reports |
| `reviews.json` | Moderation queue |
| `banners.json` | The rotating promotional strip — read by the storefront too |
| `homepage.json` | Which sections are live, and in what order |
| `settings.json` | Store settings; overrides `site-config.json` at read time |
| `navigation.json` | The portal sidebar |
| `admin-users.json`, `coupons.json`, `dashboard.json`, `notifications.json` | |

**To add one real product, edit `products.json` directly** — do not re-run the
generator, which would overwrite it. Then run `npm run data:check`, which
verifies slugs are unique, discount badges match the prices, categories and
subcategories exist, and no collection or navigation link points at something
that is not there. A new entry appears automatically in
search, its category, the relevant homepage rails (based on its flags), the
sitemap and the recommendation engine. No component changes.

### Dummy images

Product photography is currently Unsplash URLs held in `products.json`. To move
to a real CDN: change the URLs and add the host to `remotePatterns` in
`next.config.ts`. Nothing else references them, and `ProductImage` falls back to
an on-brand placeholder if a URL ever fails to load.

---

## Connecting a backend

`services/data-source.ts` defines the contract. Every method is deliberately
shaped like the endpoint that will back it:

| Method | Endpoint |
|---|---|
| `queryProducts` | `GET /products?category=&sort=&page=` |
| `getProductBySlug` | `GET /products/:slug` |
| `getProductsByIds` | `GET /products?ids=a,b,c` |
| `getRelatedProducts` | `GET /products/:id/related` |
| `getFacets` | `GET /products/facets` |
| `listCategories` | `GET /categories` |
| `listCollections` | `GET /collections` |
| `listReviews` | `GET /products/:id/reviews` |

Note that filtering, sorting and pagination are the *data source's* job, not the
UI's. Today `mock-adapter` runs them locally over JSON; tomorrow the server runs
them in SQL. Either way the services ask the same question.

`adapters/http-adapter.ts` is already written against that contract. To switch:

```bash
NEXT_PUBLIC_API_URL=https://api.dailychoicezone.com
NEXT_PUBLIC_DATA_SOURCE=http
```

No component, hook or service changes. **One thing to do first:** validate
responses in `http-adapter.ts` (zod or similar) instead of casting. A network
payload is untrusted input in a way local JSON we generate ourselves is not.

### Not yet abstracted behind the data source

These are local-only and each is confined to a single file, with the endpoints
it will need noted in its header comment:

| Concern | File | Becomes |
|---|---|---|
| Orders | `services/orderService.ts` | `POST /orders`, `GET /orders` |
| Auth | `services/authService.ts` | `POST /auth/login`, `/register`, `/logout` |
| Addresses | `services/accountService.ts` | `GET/POST/PUT/DELETE /addresses` |
| Cart & wishlist | `store/cartStore.ts`, `store/wishlistStore.ts` | server-backed cart |

### The admin API

`services/admin/admin-data-source.ts` is the portal's equivalent contract, with
the endpoint each method becomes named in its header — `GET /admin/products`,
`PUT /admin/products/:id`, `PATCH /admin/orders/:id/status`,
`POST /admin/inventory/:id/adjust`, and so on. `mock-admin-adapter.ts`
implements it over the overlay store; an HTTP adapter implements it over the
real thing. The portal's views and services do not change.

Authentication is the exception and must not be adapted — it has to be replaced.
See [This is not security](#this-is-not-security).

---

## Admin portal

`/admin` — a portal for running the store: catalogue, inventory, orders,
customers, coupons, reviews, merchandising and reports.

```
/admin/login          sign in
/admin/dashboard      KPIs, sales charts, recent orders, low stock
/admin/products       list · new · edit          /admin/categories
/admin/inventory      stock levels + adjustments  /admin/collections
/admin/orders         list · detail · status      /admin/customers
/admin/coupons        /admin/reviews              /admin/homepage
/admin/banners        /admin/reports              /admin/settings
/admin/admin-users    /admin/settings/profile
```

### This is not security

The demo credentials are **`admin@dailychoicezone.com` / `Admin@123`**, and they
are in the JavaScript bundle. Anyone who opens the portal can read them.

That is not a leak to be patched — it is what frontend-only authentication *is*.
The check runs in the browser, so it can be stepped over in a console, and every
record the portal can reach is already downloaded before the login form renders.
The role system has the same shape: `can()` decides which buttons appear, which
is a tidier interface, not a permission boundary. The portal says so on the
admin users page rather than implying otherwise.

Making it real means three things, none of which are frontend work:

1. `POST /admin/auth/login` returns an **httpOnly, Secure, SameSite** session
   cookie. The browser never holds a token it can read.
2. Every admin route is authorised **on the server**, per request. A hidden
   button is not a check.
3. The admin API is a separate surface from the storefront API, and admin data
   is never served to an unauthenticated caller.

`services/admin/adminAuthService.ts` is written to be replaced wholesale: the
credentials appear in that one module and nowhere else, and its header names the
endpoints that will take over. **Do not deploy this portal publicly as it
stands.** The storefront is fine to deploy; `/admin` is excluded from
`robots.txt` and marked `noindex`, which keeps it out of search results but is
not access control.

### One catalogue, two views

There is a single product record. `types/admin.ts` says so directly:

```ts
export type AdminProduct = Product & ProductManagement;
```

`products.json` holds the customer-facing fields, `admin/product-meta.json` holds
the management fields (status, thresholds, reserved stock, SEO, audit dates), and
`lib/admin/catalogue.ts` joins them by id. A real schema would be one table; this
is the same shape arrived at by a join, and it keeps admin concerns out of the
customer payload.

The storefront then reads `storefrontProducts()` — the same catalogue, filtered
to `active` and `out-of-stock`. Drafts and archived products are invisible to
customers, which is the only thing that makes the Draft state mean anything.

Orders store `productId` and a snapshot of what was bought, never a copy of the
live product. Deleting a product does not rewrite history, and the dashboard's
counts are recomputed from live data rather than read from a stored total — so
deleting a product or restocking one moves the numbers immediately.

### How writes are stored

There is no server, so every change is an **overlay** on the committed JSON:
records created, a map of edits by id, and a list of deleted ids, under
`dcz:admin:*` in local storage (`lib/admin/mock-store.ts`). Reading resolves the
three against the base data.

This is deliberate. The committed JSON stays the source of truth, so
`npm run data:admin` can regenerate it without destroying an admin's work; an
edit records only what changed, which is the body a `PUT` will send; and
clearing the overlay restores the demo in one action — **Settings → Reset demo
data**.

Every function in that module maps onto one HTTP verb, so
`adapters/mock-admin-adapter.ts` can be swapped for an HTTP adapter without a
caller noticing.

### What reaches the storefront, and what waits for a build

Admin changes flow back to the customer site through the same data source, so
anything the browser reads at runtime updates immediately:

| Change | Visible on the storefront |
|---|---|
| Price, stock, availability, product status | Immediately — shop, search, rails, the buy box and the cart all re-read |
| Homepage sections shown, hidden, reordered | Immediately |
| Promotional banners switched on/off or rescheduled | Immediately |
| A review approved or rejected | Immediately — only approved reviews reach a product page |
| Delivery thresholds, fees, returns window, contact details | Immediately in the cart; static pages and the footer after a rebuild |
| A **new** product's own `/product/[slug]` page | **After a rebuild** |
| Product copy, images and metadata on a prerendered page | **After a rebuild** |

The reason is the static export: `/product/[slug]` pages are written at build
time, one per slug the build knows about. Listing pages query the catalogue in
the browser and so pick up anything; a detail page is a file on disk.

Where that gap could mislead, the code closes it rather than hiding it. The buy
box re-reads price and stock after hydration (`hooks/useLiveProduct.ts`), because
a stale price there is a wrong charge and not a cosmetic lag — and the product
page shows that price in exactly one place so two figures can never disagree. In
the portal, a product with no built page shows a struck-through "view on
storefront" control explaining why, instead of a link that would certainly 404.

On a Node deployment with `output: "export"` removed and revalidation enabled,
the rebuild column disappears.

### Shared pieces

**One table.** `components/admin/ui/DataTable.tsx` owns sorting, paging,
selection, empty and loading states for every list in the portal. Pages supply
columns and the already-filtered rows — filter controls differ on every page,
table mechanics do not.

**Charts are hand-built SVG** (`components/admin/charts/`), sized from a
`ResizeObserver` so they render at real pixels. The palette in `globals.css` is
validated for colour-vision deficiency rather than chosen by eye, categorical
hues are assigned in fixed order, and there is deliberately no dual-axis chart
anywhere — two measures of different scale get two charts.

**The portal's visual language is its own.** Denser spacing, tighter radii, a
neutral working surface, brand copper used only as an accent. It reads as a tool
rather than a shopfront, while still belonging to the same brand.

---

## What is deliberately not real

This is a frontend. It is honest about that in the UI rather than pretending:

- **No payment gateway.** Checkout collects a payment *method*, never a card
  number, CVV or UPI ID. A real integration hands off to the provider's own
  hosted fields, which is also how it should work in production.
- **Mock authentication.** Any valid email with a six-character password signs
  you in. No password is stored anywhere, hashed or otherwise.
- **Orders are local.** Placing an order writes a realistic record to local
  storage so the account area has something true to show. Nothing is fulfilled.
- **Forms do not send.** The contact form and newsletter confirm and clear;
  nothing leaves the browser.
- **Admin sign-in is a demonstration.** Fixed credentials, checked in the
  browser, with no authorisation behind them. Roles shape the interface only.
  [Details](#this-is-not-security).
- **Admin changes are local to one browser.** They live in that browser's local
  storage, are invisible to anyone else, and reset with one button.

---

## Brand

The design system is derived from the logo in `public/brand/logo.png` — the
cream disc, the copper ring, the near-black of "Daily", the terracotta of
"Choice", the green leaf and the blush/sage/peach trust icons. Every colour,
type and spacing token lives in `src/app/globals.css` under `@theme`.

Components should reach for a token rather than introducing a new value. The
palette is intentionally narrow: warm neutrals and one accent, so product
photography carries the colour.

Typography pairs a high-contrast serif (Playfair Display) with a quiet
grotesque (Inter), which is the same relationship the logo strikes between
"Daily Choice" and the wide-tracked "ZONE".

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
