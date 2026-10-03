# Customer segmentation

This is the design and the API contract for customer segmentation:

- a precomputed **customer metrics** table (one row per customer) with RFM scores,
- a reusable, rule-based **segment engine** (a field registry, a rule validator
  and a compiler that turns rules into one parameterised SQL query),
- saved **segments** with a materialised membership, a history and CSV export,
- the integrations: **campaigns** can target a segment, **coupons** can be
  restricted to one.

It is the single source of truth that the backend and the frontend are both
built against. Field names below are exactly what the API sends and accepts:
camelCase on the wire, as everywhere else in this project.

All responses use the project envelope: `{ success, data, message }`. Lists use
`{ success, data: { items, pagination } }`. Errors use
`{ success: false, message, error_code, details? }`.

## 1. How it fits the existing system

| Existing piece | How it is reused |
|---|---|
| Orders, refunds, returns, coupons, wishlist, carts, abandoned carts, memberships, reward points, store credit, gift cards, referrals, campaign recipients, marketing consent, storefront analytics events, addresses | Read (never written) by the metrics refresh, in batches, with one grouped query per source. Refund tables are only read. |
| `orders.update_status` and friends | Untouched. A session `after_flush` hook notices orders, refunds, returns, memberships, wishlist lines and new customers and marks the customer's metrics row **dirty** (one upsert). The `segments` job refreshes dirty rows within minutes. |
| `campaigns.clean_audience` / `audience_ids` / `reachable` | `audience.segmentId` (optional) restricts the existing filters to a saved segment's members. Consent and reachability are applied afterwards exactly as before. Every older audience shape keeps working. |
| `coupons.audience_refusal` | New audience value `segment` with `segmentId`: the customer must match the segment's rules **now** (evaluated live for that one customer against their metrics). |
| `SettingDocument` | Key `segmentation` holds the RFM bands and the label map (editable in the portal). |
| `audit.record` | Every create, edit, archive, restore, recalculation, settings change and **export** is audited. |
| `jobs.tracked` + `run_forever` + lifespan | New job `segments` (every 10 minutes): dirty refreshes, the periodic full refresh, membership recalculation. |
| RBAC (`require_access`) | New permissions `segments` and `segments-export`. The customers admin routes now require `customers` (see §2). |

## 2. Permissions

| Permission | Covers | Roles |
|---|---|---|
| `segments` | Viewing, creating, editing, archiving, recalculating segments; preview; RFM settings | super-admin, admin, manager |
| `segments-export` | CSV export, and **unmasked** email/phone in member lists and previews | super-admin, admin |

Without `segments-export`, email and phone are masked (`a••••@example.com`,
`987•••00001`).

**Customers admin routes.** `GET /api/admin/customers` (every customer, with
contact details) now requires `customers`. `GET /api/admin/customers/{id}`
requires `customers` **or** `orders`, so staff working an order can still open
the customer behind it. Blocking (`PUT .../status`) still requires `customers`.
Editors (who have neither) now get 403 where they used to read every customer.
The portal's global search tolerates the 403 and simply shows no customer hits.

## 3. Customer metrics

Table `customer_metrics`, one row per customer (PK `customer_id`, FK → customers
CASCADE). Money in **paise** (BIGINT). Dates are UTC.

| Column | Meaning |
|---|---|
| `total_orders` | Orders not cancelled (returned ones included) |
| `kept_orders` | Orders neither cancelled nor returned |
| `total_spend` | Σ total of kept orders − completed refunds on kept orders (partial refunds), never below 0 |
| `average_order_value` | `total_spend ÷ kept_orders` (0 without kept orders) |
| `first_order_at`, `last_order_at` | First / last non-cancelled order |
| `cancelled_orders`, `returned_orders` | Orders in those statuses |
| `refunded_orders` | Orders with at least one completed refund |
| `return_requests` | Return/replacement requests not rejected or cancelled |
| `coupon_uses` | Coupon redemptions |
| `wishlist_items` | Wishlist lines |
| `has_active_cart` | Has lines in the bag now |
| `abandoned_carts` | Bags ever marked abandoned; `has_abandoned_cart`: one is abandoned now |
| `products_viewed_90d`, `categories_viewed_90d` | Distinct products / categories viewed in the last 90 days (storefront `product_view` events while signed in) |
| `purchased_category_ids` | JSON list of the categories of products bought in non-cancelled orders |
| `membership_status` | `active` / `expired` / `cancelled` / `none` (latest membership); `membership_plan_id`, `membership_ends_at` |
| `points_balance` | Spendable reward points (released, unexpired lots − debt) |
| `store_credit_balance` | Paise |
| `gift_card_orders`, `gift_card_spend` | Orders paid partly by gift card, and what gift cards paid (paise, net of reversals) |
| `was_referred`, `referral_count` | Signed up through a referral; referrals of theirs that were rewarded |
| `email_opt_in`, `sms_opt_in`, `whatsapp_opt_in` | Marketing consent per channel (the channel's default when they never chose) |
| `campaigns_received`, `campaign_opens`, `campaign_clicks`, `last_engaged_at` | From campaign recipients (opens only where the channel reports them) |
| `city`, `state`, `pincode` | Default address, else any saved address, else the last order's delivery address |
| `recency_score`, `frequency_score`, `monetary_score` | 1–5, or 0 for a customer with no kept order |
| `rfm_label` | `champions`, `loyal`, `potential`, `new`, `at-risk`, `hibernating`, `lost`, or `no-orders` |
| `dirty`, `marked_at`, `refreshed_at` | Refresh bookkeeping |

Registration date, last sign-in, email verification, account status, name and
email are read live from `customers`.

### Refresh

- **Dirty refresh** (every job pass, ≤ 5,000 customers per pass, 500 per batch):
  customers whose row is dirty, plus customers who have no row yet.
- **Full refresh** when the oldest row is older than `refreshHours` (default 6),
  in batches of 500, and on demand (`POST /api/admin/segments/metrics/refresh`).
- Each batch runs one grouped query per source restricted to the batch's ids,
  and writes the batch back with one multi-row upsert. Nothing ever loads every
  customer into Python. A row marked dirty while its batch was being computed
  stays dirty (`marked_at ≥ batch start`), so a concurrent change is never lost.
- Page loads never aggregate: lists and the dashboard read `customer_metrics`.

### RFM

Configured in `SettingDocument("segmentation")` (defaults shown):

```json
{
  "recencyDays": [30, 60, 90, 180],
  "frequencyOrders": [2, 3, 5, 8],
  "monetaryRupees": [1000, 3000, 7500, 15000],
  "refreshHours": 6,
  "labels": [
    { "key": "champions",   "label": "Champions",   "r": [4, 5], "f": [4, 5], "m": [4, 5] },
    { "key": "loyal",       "label": "Loyal",       "r": [3, 5], "f": [3, 5], "m": [1, 5] },
    { "key": "new",         "label": "New",         "r": [4, 5], "f": [1, 1], "m": [1, 5] },
    { "key": "potential",   "label": "Potential",   "r": [3, 5], "f": [1, 2], "m": [1, 5] },
    { "key": "at-risk",     "label": "At risk",     "r": [1, 2], "f": [3, 5], "m": [1, 5] },
    { "key": "hibernating", "label": "Hibernating", "r": [2, 2], "f": [1, 2], "m": [1, 5] },
    { "key": "lost",        "label": "Lost",        "r": [1, 1], "f": [1, 2], "m": [1, 5] }
  ]
}
```

- **Recency** (days since the last kept order): ≤ 30 → 5, ≤ 60 → 4, ≤ 90 → 3, ≤ 180 → 2, otherwise 1.
- **Frequency** (kept orders): ≥ 8 → 5, ≥ 5 → 4, ≥ 3 → 3, ≥ 2 → 2, otherwise 1.
- **Monetary** (net spend in rupees): ≥ 15,000 → 5, ≥ 7,500 → 4, ≥ 3,000 → 3, ≥ 1,000 → 2, otherwise 1.
- **Label**: the first entry of `labels` whose three ranges all contain the
  scores. The defaults cover every combination; if an edited map leaves a gap,
  the customer's label is `lost` when R is 1, otherwise `potential`.
- No kept order: scores 0, label `no-orders`.

Validation: each band list has exactly 4 strictly increasing positive numbers;
each label `key` is one of the seven and appears at most once; ranges are
`[min, max]` with 1 ≤ min ≤ max ≤ 5; `label` 1–40 characters; `refreshHours`
1–48. Saving re-scores every metrics row (in batches, from the stored figures)
and recalculates the active segments.

## 4. Segments

### Rules

```json
{
  "match": "all",
  "rules": [
    { "field": "totalOrders", "operator": "gte", "value": 2 },
    { "match": "any", "rules": [
        { "field": "city", "operator": "in", "value": ["Bengaluru", "Mysuru"] },
        { "field": "lastOrderAt", "operator": "within-last-days", "value": 30 }
    ] }
  ]
}
```

- `match`: `all` (AND) or `any` (OR).
- A rule is a condition `{ field, operator, value }` or a group
  `{ match, rules: [conditions] }`. One level of groups; a group can't contain
  a group, and can't be empty.
- At most 30 conditions in all; an empty top-level list matches every customer.

### Field registry

`GET /api/admin/segments/fields` is the single source of truth for the builder
and the evaluator.

| Group | Fields (key · type) |
|---|---|
| Profile | `joinedAt` date · `lastLoginAt` date · `emailVerified` boolean · `accountStatus` enum (active, blocked) · `name` string · `email` string · `city` string · `state` string · `pincode` string |
| Shopping | `totalOrders` number · `totalSpend` money · `averageOrderValue` money · `firstOrderAt` date · `lastOrderAt` date · `cancelledOrders` number · `returnedOrders` number · `refundedOrders` number · `returnRequests` number · `couponUses` number · `hasActiveCart` boolean · `hasAbandonedCart` boolean · `abandonedCarts` number · `rfmLabel` enum · `recencyScore` / `frequencyScore` / `monetaryScore` number (0–5) |
| Products | `purchasedCategories` list (options: categories) · `purchasedProducts` list (product ids) · `productsViewed90d` number · `categoriesViewed90d` number · `wishlistItems` number |
| Marketing | `emailOptIn` / `smsOptIn` / `whatsappOptIn` boolean · `campaignsReceived` / `campaignOpens` / `campaignClicks` number · `lastEngagedAt` date · `wasReferred` boolean · `referralCount` number |
| Membership | `membershipStatus` enum (active, expired, cancelled, none) · `membershipPlan` enum (options: plans) |
| Loyalty | `pointsBalance` number · `storeCreditBalance` money · `giftCardOrders` number · `giftCardSpend` money |

Operators by type:

| Type | Operators | Value |
|---|---|---|
| number | `equals`, `not-equals`, `gt`, `lt`, `gte`, `lte`, `between` | a whole number within the field's `min`/`max`; `between`: `[low, high]` |
| money | same as number | rupees (up to 2 decimals), 0 – 1,00,00,000; compared in paise |
| date | `equals`, `before`, `after`, `between`, `within-last-days`, `not-within-last-days` | `YYYY-MM-DD` (a UTC calendar day); `between`: `[from, to]` inclusive; the `*-days` operators: 1 – 3650 |
| string | `equals`, `not-equals`, `contains`, `not-contains`, `starts-with`, `ends-with`, `in`, `not-in` | text, 1 – 120 characters (case-insensitive); `in`/`not-in`: a list of 1 – 100 |
| enum | `equals`, `not-equals`, `in`, `not-in` | one of the field's `options` (or a list of them) |
| list | `contains`, `not-contains`, `in`, `not-in` | `contains`: one value; `in` (has any of) / `not-in` (has none of): a list of 1 – 100 |
| boolean | `equals` | `true` / `false` |

Date semantics: `before D` is earlier than D; `after D` is later than D (from
the next day); a missing date (never ordered) matches only
`not-within-last-days`.

Response:

```json
{
  "groups": [ { "key": "profile", "label": "Profile" }, ... ],
  "fields": [ { "key": "totalSpend", "label": "Total spend", "group": "shopping", "type": "money",
                "operators": ["equals","not-equals","gt","lt","gte","lte","between"],
                "options": [], "unit": "₹", "description": "Net of refunds; cancelled and returned orders excluded",
                "min": 0, "max": 10000000 } , ... ],
  "operators": [ { "key": "gte", "label": "is at least", "value": "single" | "range" | "list" | "days" | "none" }, ... ],
  "limits": { "maxConditions": 30, "maxListItems": 100 }
}
```

Validation errors are `422 INVALID_SEGMENT_RULE` with a message that names the
problem ("Total spend: “between” needs two amounts, the lower first.") and
`details: { path: "rules.1.rules.0", field, operator }`.

### Evaluation

Rules compile to **one** SQLAlchemy query over `customers ⋈ customer_metrics`
(list fields add an `EXISTS` over order lines, or `JSON_CONTAINS` on the
purchased categories). Every value is a bound parameter; nothing a user types is
ever formatted into SQL. Field keys and operators are looked up in the registry,
so an unknown one is a validation error, never SQL.

### Membership

`segment_members (segment_id, customer_id, added_at)`, PK on both. Recalculating
a segment is a diff in SQL: `DELETE` the members who no longer match, then
`INSERT … SELECT` the matches who aren't members yet, so nothing is loaded into
Python and unchanged members keep their `added_at`. It happens:

- on save (create and rule changes),
- on demand (**Recalculate**),
- in the job: after each dirty refresh only for the refreshed customers, and for
  everyone after a full refresh.

`member_count` and `last_calculated_at` are kept on the segment.

### Default segments

Seeded **lazily and idempotently** the first time segments are read (list,
summary, campaign options, or the job), by slug: a default is inserted only when
no segment with its slug exists. They are ordinary rows (`kind: "default"`):
editable and archivable, never deleted (archive instead), and never re-created
over an edit.

| Slug | Name | Rules |
|---|---|---|
| `new-customers` | New Customers | joinedAt within-last-days 30 |
| `returning-customers` | Returning Customers | totalOrders ≥ 2 AND lastOrderAt within-last-days 180 |
| `vip` | VIP | totalSpend ≥ ₹25,000 AND totalOrders ≥ 5 AND lastOrderAt within-last-days 180 |
| `high-value` | High Value | totalSpend ≥ ₹10,000 |
| `frequent-buyers` | Frequent Buyers | totalOrders ≥ 5 |
| `inactive` | Inactive | totalOrders ≥ 1 AND lastOrderAt not-within-last-days 180 |
| `at-risk` | At-Risk | rfmLabel in [at-risk] |
| `coupon-users` | Coupon Users | couponUses ≥ 1 |
| `non-coupon-customers` | Non-Coupon Customers | totalOrders ≥ 1 AND couponUses = 0 |
| `recent-buyers` | Recent Buyers | lastOrderAt within-last-days 30 |
| `one-time-buyers` | One-Time Buyers | totalOrders = 1 |
| `repeat-buyers` | Repeat Buyers | totalOrders ≥ 2 |
| `cart-abandoners` | Cart Abandoners | hasAbandonedCart = true |
| `wishlist-users` | Wishlist Users | wishlistItems ≥ 1 |
| `membership-customers` | Membership Customers | membershipStatus = active |

### History

`segment_events`: `created`, `updated` (name/description), `rules-changed`
(`details.before` / `details.after`), `recalculated` (`details.before` /
`details.after` counts; recorded for manual recalculations, and for automatic
ones only when the count changed), `archived`, `restored`, `exported`
(`details.rows`). Each with the actor (`ADM001` or `system`) and the time.

## 5. Database (migration `20261008_1100_customer_segments`)

- `customer_metrics`: as §3. Indexes: `refreshed_at`, `dirty`, `total_orders`,
  `total_spend`, `last_order_at`, `rfm_label`, `city`, `membership_status`.
- `segments`: `id` PK, `name`, `slug` UNIQUE, `description`, `match`, `rules`
  JSON, `kind` (default/custom), `status` (active/archived, indexed),
  `member_count`, `last_calculated_at`, `created_by`, `updated_by`,
  `archived_at`, `created_at`, `updated_at`.
- `segment_members`: (`segment_id` FK CASCADE, `customer_id` FK CASCADE) PK,
  `added_at`; index on `customer_id`.
- `segment_events`: `id` PK, `segment_id` FK CASCADE, `action`, `actor`,
  `actor_name`, `details` JSON, `occurred_at`; index (`segment_id`, `occurred_at`).
- `coupons.segment_id`: new nullable column, FK → segments SET NULL, indexed.

## 6. API contract (admin; `segments` unless noted)

Segment summary (list rows):

```json
{ "id": 3, "name": "VIP", "slug": "vip", "description": "...", "kind": "default" | "custom",
  "status": "active" | "archived", "match": "all", "conditionCount": 3,
  "memberCount": 42, "lastCalculatedAt": "2026-10-08T06:00:00", "createdBy": "system",
  "updatedBy": "ADM001", "createdAt": "...", "updatedAt": "..." }
```

Member row:

```json
{ "customerId": "CUS001", "name": "Asha Rao", "email": "a••••@example.com", "phone": "987•••00001",
  "city": "Bengaluru", "state": "Karnataka", "totalOrders": 4, "totalSpend": 5400.0,
  "averageOrderValue": 1350.0, "lastOrderAt": "...", "joinedAt": "...",
  "rfmLabel": "loyal", "rfmScore": "343", "pointsBalance": 120, "addedAt": "..." }
```

`email`/`phone` are unmasked only for an admin with `segments-export`;
`masked: true|false` accompanies every list.

- `GET /api/admin/segments?q=&status=active|archived|all&kind=default|custom&page=1&pageSize=25`
  → `{ items: [summary], pagination, counts: { active, archived } }`. `status` defaults to `active`.
- `GET /api/admin/segments/fields` → the registry (above).
- `POST /api/admin/segments/preview` with `{ match, rules, page?, pageSize? (≤ 25) }`
  → `{ count, items: [member], page, pageSize, masked }`. Unsaved rules; nothing is written.
- `POST /api/admin/segments` with `{ name, description?, match, rules }` → 201 segment detail.
  - `name` 2–120 characters, unique case-insensitively among segments (409 `SEGMENT_NAME_TAKEN`).
  - The slug is derived from the name and kept.
- `GET /api/admin/segments/{id}` → segment detail:

```json
{ ...summary, "rules": [...],
  "rfm": { "labels": [ { "key": "champions", "label": "Champions", "count": 5 } ],
           "recency": [ { "score": 5, "count": 3 } ], "frequency": [...], "monetary": [...] },
  "history": [ { "id": 1, "action": "recalculated", "label": "Recalculated", "actor": "ADM001",
                 "actorName": "Manoj", "details": { "before": 40, "after": 42 }, "at": "..." } ],
  "actions": { "edit": true, "archive": true, "restore": false, "recalculate": true, "export": true } }
```

- `PUT /api/admin/segments/{id}` with `{ name?, description?, match?, rules? }` → segment detail.
  Archived segments can't be edited (409 `SEGMENT_ARCHIVED`). Changing rules records
  `rules-changed` and recalculates.
- `POST /api/admin/segments/{id}/recalculate` → segment detail (`message` gives before → after).
- `POST /api/admin/segments/{id}/archive`, `POST /api/admin/segments/{id}/restore` → segment detail.
- `GET /api/admin/segments/{id}/members?q=&page=&pageSize=` → `{ items: [member], pagination, masked }`.
  `q` matches customer id, name, email or phone.
- `GET /api/admin/segments/{id}/export` (**`segments-export`**) → `text/csv` attachment
  `segment-<slug>-<date>.csv`, every member, unmasked. Audited (`segment.export`) and
  recorded in the history. Cells starting with `= + - @` are prefixed with `'`.
- `GET /api/admin/segments/settings` → `{ settings: {…as §3}, status: { customers, metrics, dirty, oldestRefreshAt, newestRefreshAt } }`.
- `PUT /api/admin/segments/settings` with the settings object → same shape. 422 `INVALID_SEGMENT_SETTINGS`.
- `POST /api/admin/segments/metrics/refresh` → `{ refreshed, segments }`: a full refresh now, then every active segment recalculated.
- `GET /api/admin/segments/summary` → `summary(db)`: `{ totalCustomers, newCustomers30d, returningCustomers, vip, atRisk, activeSegments, oldestRefreshAt }`.

Errors: 404 `SEGMENT_NOT_FOUND`; 409 `SEGMENT_ARCHIVED`, `SEGMENT_NAME_TAKEN`;
422 `INVALID_SEGMENT`, `INVALID_SEGMENT_RULE`, `INVALID_SEGMENT_SETTINGS`.

### Campaigns

- `audience.segmentId` (integer or null) on campaign create/update/estimate. The
  existing filters still apply on top (intersection), then consent and
  reachability, as before.
- An unknown segment → 422 `SEGMENT_NOT_FOUND`; an archived one → 422 `SEGMENT_ARCHIVED`.
- `GET /api/admin/campaigns/options` adds `savedSegments: [ { id, name, memberCount, lastCalculatedAt } ]` (active ones).
- The audience is the segment's materialised members, so the number previewed is
  the number launched (unless the segment is recalculated in between, which the
  launch confirmation already catches as `AUDIENCE_CHANGED`).

### Coupons

- `audience: "segment"` with `segmentId` on `POST/PUT /api/admin/coupons`. The
  segment must exist and be active (422 `SEGMENT_REQUIRED` / `SEGMENT_NOT_FOUND` / `SEGMENT_ARCHIVED`).
- `GET /api/admin/coupons` rows add `segmentId` and `segmentName`.
- At validation the customer must be signed in and match the segment's rules
  at that moment ("That code isn't available on your account." otherwise). An
  archived or deleted segment refuses everyone.

### Frontend routes

| Page | Route |
|---|---|
| Segments list (+ link to RFM settings, "Refresh metrics") | `/admin/customers/segments` |
| New segment / edit (builder with live preview) | `/admin/customers/segments/edit` , `/admin/customers/segments/edit?id=3` |
| Segment detail (members, RFM chart, history, recalculate, export, archive) | `/admin/customers/segments/detail?id=3` |
| RFM settings | `/admin/customers/segments/settings` |
| Send campaign to this segment | `/admin/marketing/campaigns/detail?segmentId=3` (a new campaign with `audience.segmentId` prefilled) |
| Create coupon for this segment | `/admin/coupons?new=1&segmentId=3` (opens the new-coupon dialog with audience `segment`) |

The sidebar entry `segments` ("Segments", icon `segments`) sits right after
Customers.

## 7. Background job `segments` (every 10 minutes)

1. Seed the default segments if missing.
2. Create rows for customers without one and refresh dirty rows (≤ 5,000 per
   pass), then recalculate every active segment for just those customers.
3. When the oldest row is older than `refreshHours`: refresh everyone in batches,
   then recalculate every active segment in full.

`sweep(db)` returns `{ seeded, refreshed, full, segments }`.

## 8. Configuration

Everything is configured in the portal (RFM settings). Optional `.env`:

- `SEGMENTS_JOB_INTERVAL_SECONDS=600`

## 9. Testing

```bash
cd backend
TEST_DATABASE_NAME=dcz_seg pytest tests/unit/test_segment_rules.py tests/integration/test_segments_*.py
cd ../frontend
npx vitest run src/components/admin/views/segments
npx tsc --noEmit
```

## 10. Troubleshooting

- **Counts look stale.** Metrics are refreshed by the job (dirty rows within ~10
  minutes, everyone every `refreshHours`). Use **Refresh metrics** on the list
  page, or **Recalculate** on a segment, to update now.
- **A segment shows 0 members after a deploy.** The metrics table starts empty;
  the first job pass (or **Refresh metrics**) fills it.
- **"not within the last N days" includes people who never ordered.** By
  design: they haven't ordered in that time. Add `totalOrders ≥ 1` to exclude them.
