# Search, filters and search analytics

This is the design and the API contract for:

- relevance search over the catalogue (still MySQL, behind a `SearchBackend` interface),
- typo tolerance ("did you mean") from a term dictionary,
- search-as-you-type suggestions,
- dynamic product attributes (material, capacity, dishwasher-safe…) that become filters,
- disjunctive faceted filtering, new sorts, URL-based filters,
- server-side search, filtering and paging for the admin product list,
- search analytics (what people search for, what finds nothing, what they click and buy).

Field names below are exactly what the API sends and accepts: camelCase on the
wire. Every response uses the project envelope `{ success, data, message }`;
lists use `{ success, data: [...], pagination }`; errors use
`{ success: false, message, error_code, details? }`.

## 1. How it fits the existing system

| Existing piece | How it is reused |
|---|---|
| `GET /api/products` + `ProductQuery` | Still the one listing endpoint. It gains multi-category, attribute filters, availability, more sorts, relevance ranking and typo fallback. Every existing parameter and sort keeps working. |
| `GET /api/products/facets` | Same endpoint; counts are now **disjunctive** (each facet counted with every *other* filter applied) and it gains price buckets, ratings, discounts, availability and attribute facets. |
| `repositories/products.py` | Keeps the SQL for filters, sorts and facets. The free-text part moved behind `services/search/` (`SearchBackend`). |
| `GET /api/admin/products` | Becomes the admin list's only data source: server-side search, filters, sorts, paging and status counts. The portal no longer downloads the catalogue to filter it. |
| `content.popularSearches` (Settings → Content) | Stays the **curated** popular-searches list. Search settings can switch to **auto** (top searches from analytics) instead. |
| `analytics_events` (`visitor_key`, `add_to_cart` events) | The visitor hash for search logs is made the same way. Conversion reads the existing `add_to_cart` events and orders. |
| `jobs.tracked` + `run_forever` + lifespan | New job `search`: daily aggregates, conversions, term dictionary, `search_text` and units-sold refresh. |
| `audit.record` | Attribute CRUD, product attribute values, search settings, manual rebuild. |
| `rate_limit` | Public search, suggestions and click logging are rate-limited per IP. |

## 2. Permissions

| Permission | Covers | Roles |
|---|---|---|
| `products` (existing) | Attribute definitions and product attribute values | super-admin, admin, manager, editor, staff |
| `search` (new) | Search analytics, search settings (popular searches, synonyms), manual rebuild | super-admin, admin, manager, editor |

Every check is made on the server (`require_access`).

## 3. Search architecture

`app/services/search/`:

- `base.py`: the `SearchBackend` interface (`match_condition(query)`, `relevance(query)`, `suggest_products(...)`) and `normalise()`, `escape_like()`.
- `mysql.py`: **MySQL** backend (the default): `LIKE` with escaped wildcards over the product columns plus a denormalised `search_text` column, a computed relevance score for ordering.
- `registry.py`: `backend()` picks the implementation from `SEARCH_BACKEND` (only `mysql` today). Elasticsearch, OpenSearch or Meilisearch is one more module implementing the interface, plus one registry entry.
- `dictionary.py`: the term dictionary (`search_terms`) and the edit-distance "did you mean".
- `settings.py`: popular searches and the synonym groups (`synonym_map`), applied at query time by `registry.parse`.
- `suggest.py`: the suggestions endpoint.
- `analytics.py`: logging searches and clicks, conversions, daily aggregates, the admin report, `summary(db)`.
- `settings.py`: the `search` settings document (popular mode, synonyms).
- `jobs.py`: the `search` background job.
- `attributes.py`: attribute definitions, options and product values.

### Matching

The term is normalised (lower-case, trimmed, inner whitespace collapsed, at most
200 characters) and split into words. **Every word must match something** (so
"steel bottle" finds steel bottles, not every steel thing plus every bottle).
A word matches when it, or one of its synonyms, appears in the product's name,
brand, SKU, subcategory, material, description, a tag, or `search_text`.

`search_text` is a denormalised, lower-case column (in `product_search_index`, one row per product) holding what
lives in other tables: the category name, collection names, colour names,
specification values and searchable attribute values. It is rebuilt when a
product (or its attribute values) is saved, and for the whole catalogue by the
`search` job and by **Rebuild now**.

`%`, `_` and the escape character in the term are escaped, so `50%` and `a_b` mean themselves.

### Ranking (`sort=relevance`, the default when a term is present)

Higher score first, then the merchandising order, then id (so pages never overlap):

| Signal | Score |
|---|---|
| name equals the whole term | 100 |
| SKU equals the term | 90 |
| name starts with the term | 60 |
| SKU starts with the term | 50 |
| a word in the name starts with the term | 40 |
| per word: a name word starts with it | 15 |
| per word: brand equals / starts with it | 12 / 8 |
| per word: name contains it | 8 |
| per word: a tag equals it | 8 |
| per word: category, collection or attribute value (`search_text`) contains it | 5 |
| per word: description contains it | 2 |

Case-insensitive (the `utf8mb4_unicode_ci` collation).

### Why not a FULLTEXT index (measured)

A MySQL 8 InnoDB `FULLTEXT(name, brand, description)` index was considered and
not used:

- **InnoDB full-text search does not see uncommitted rows.** A product saved in
  the same transaction is invisible to `MATCH … AGAINST` until commit, which
  breaks read-your-writes in the services and makes the transactional test
  suite unable to test search at all.
- It tokenises by `innodb_ft_min_token_size` (3) and a stop-word list, so `xl`,
  `tv` or `a4` would never match without server configuration the app can't
  rely on.
- Substring and SKU-prefix matching (`DCZ-EL00`) still need `LIKE`.

At catalogue sizes this store targets, the `LIKE` scan is fast enough: the
benchmark test (`tests/integration/test_search_performance.py`) seeds 5,000
products and asserts a search listing and the full facet set each finish in
under the bound (see section 10 for the measured figures). Above roughly
50–100k products, move to a dedicated engine through `SearchBackend`.

### Typo tolerance

`search_terms` is a dictionary of words that appear in product names, brands,
categories, subcategories, tags and attribute values, each with a frequency.
It is maintained when a product or attribute is saved (its words are added) and
rebuilt from scratch by the job.

When a search finds **nothing**, each word not in the dictionary is replaced by
the closest dictionary word (Damerau–Levenshtein distance ≤ 1 for words of up to
4 letters, ≤ 2 otherwise; ties go to the more frequent word; candidates are
pre-filtered by length and first or last letter). If that changes the term and
the corrected term finds products, those are returned with
`search.correctedTerm` set, and the page says *Showing results for "shirt"*.

### Synonyms

Admin → Search → Settings holds synonym groups, e.g. `tee, t-shirt, tshirt`.
At query time each word is matched as *any* member of its group. Groups are
bounded (200 groups, 10 terms each, 40 characters per term).

## 4. Database (migration `20261008_1200_search_filters`)

A new table `product_search_index` (one row per product, primary key `product_id`, so `products` itself is not altered; the job and every product save keep it current):

- `search_text` VARCHAR(1000) NOT NULL DEFAULT ''
- `units_sold` INT NOT NULL DEFAULT 0, indexed: units on paid / fulfilled orders (not cancelled, not awaiting payment), refreshed by the job; sorts **best-selling**.

New indexes on existing tables:

| Index | Why |
|---|---|
| `products (price)` `ix_products_price` | price sorts and ranges |
| `products (rating)` `ix_products_rating` | rating sort, `minRating` |
| `products (created_at)` `ix_products_created_at` | newest / oldest |
| `products (status, price)` `ix_products_status_price` | the shop's price sort within published products |
| `products (status, created_at)` `ix_products_status_created` | the shop's newest sort |
| `product_search_index (units_sold)` | best-selling |
| `product_sizes (label, product_id)` `ix_product_sizes_label` | size filter / facet |
| `product_colors (name, product_id)` `ix_product_colors_name` | colour filter / facet |

New tables:

- `product_attributes`: `id` PK, `code` UNIQUE (lower-case `a-z0-9_`, 2–40), `label`, `type` (`select` / `multi` / `number` / `boolean`), `unit`, `filterable`, `searchable`, `position`, `status` (`active` / `archived`), `created_at`, `updated_at`. Index `(status, position)`.
- `product_attribute_options`: `id` PK, `attribute_id` FK CASCADE, `value` (normalised slug), `label`, `position`; UNIQUE(`attribute_id`, `value`).
- `product_attribute_values`: `id` PK, `product_id` FK CASCADE, `attribute_id` FK CASCADE, `value` (display text), `value_normalized`, `value_number` DECIMAL(14,4) NULL; UNIQUE(`product_id`, `attribute_id`, `value_normalized`); indexes `(attribute_id, value_normalized, product_id)` for filters and facets, `(attribute_id, value_number)` for ranges, `product_id`.
- `search_terms`: `id` PK, `term` UNIQUE, `length`, `kind` (name / brand / category / tag / attribute), `frequency`, `updated_at`; index `(length)`.
- `search_queries`: `id` PK, `term` (normalised), `results_count`, `zero_results`, `corrected_term`, `visitor_hash`, `customer_id` NULL, `filters` (e.g. `category,brand,price`), `sort`, `created_at`; indexes `(created_at)`, `(term, created_at)`, `(visitor_hash, created_at)`.
- `search_clicks`: `id` PK, `search_id` FK→search_queries CASCADE, `product_id` FK→products CASCADE, `position`, `visitor_hash`, `customer_id` NULL, `converted` , `converted_at` NULL, `created_at`; UNIQUE(`search_id`, `product_id`); indexes `(created_at)`, `product_id`.
- `search_daily_stats`: `id` PK, `day` DATE, `term`, `searches`, `zero_results`, `clicks`, `conversions`, `avg_results`; UNIQUE(`day`, `term`); index `(day)`.

Search settings live in the `setting_documents` row `search` (created on first save):
`{ popularMode: "curated" | "auto", synonyms: [["tee","t-shirt"]], lastRebuildAt }`.
The curated list itself stays `content.popularSearches`.

**No personal data.** A search log keeps the normalised term, counts, a hashed
visitor id (the same keyed hash as `analytics_events`) and the customer id when
signed in. No IP, no user agent, no raw term.

## 5. API contract: storefront

### `GET /api/products`

Existing parameters keep their meaning. New or changed:

| Parameter | Meaning | Validation |
|---|---|---|
| `search` | free text | ≤ 200 chars (422 above) |
| `category` | **one or more** category slugs or ids, CSV | ≤ 50 values, each ≤ 120 chars |
| `subcategory` | one or more subcategory slugs, CSV | same |
| `brands`, `sizes`, `colors` | CSV, OR within the list | same |
| `minPrice`, `maxPrice` | rupees | 0 – 10,000,000 (422 outside); an inverted range is simply empty |
| `minRating` (alias `rating`) | 4 = "4★ & above" | 0 – 5 |
| `minDiscount` | percent | 0 – 100 |
| `inStockOnly=true` | **available** stock > 0 (stock − reserved). Was `stock > 0`: fixed. | |
| `availability` | `in-stock` / `out-of-stock` | anything else → 422 |
| `attr.<code>` | select / multi: CSV of option values (OR); boolean: `true` / `false` | unknown or non-filterable codes are ignored; ≤ 20 attribute filters; ≤ 30 values each |
| `attr.<code>.min`, `attr.<code>.max` | number attribute range | non-numbers ignored |
| `sort` | `relevance` · `recommended` · `newest` · `oldest` · `price-asc` · `price-desc` · `rating` · `popular` · `best-selling` · `discount` · `availability` | anything else → 422. Default: `relevance` when `search` is present, otherwise `recommended`. `relevance` without a term means `recommended`. |
| `visitorId` | the storefront's random analytics visitor id (only used, hashed, for the search log) | `^[A-Za-z0-9_-]{8,64}$`, otherwise ignored |

Filters combine with AND between dimensions and OR within one.

Response (when `search` is present, a `search` object is added):

```json
{
  "success": true,
  "data": [ { "id": "PRD001", "name": "Steel Bottle", "...": "ProductOut, unchanged" } ],
  "pagination": { "page": 1, "page_size": 24, "total": 37, "total_pages": 2 },
  "search": { "term": "stel botle", "correctedTerm": "steel bottle", "searchId": 812 }
}
```

- `correctedTerm` is `null` unless the original term found nothing and the corrected one did.
- `searchId` is set on page 1 of a search (that is what gets logged; later pages, re-sorts and facet calls are not new searches). Repeating the identical search (same visitor, term and filters) within 60 seconds returns the same id rather than logging again.
- Public searches are rate-limited to 120 per minute per IP (429 `RATE_LIMITED`).

### `GET /api/products/facets`

Takes exactly the same parameters as the listing. **Disjunctive**: the counts
for a dimension are computed with every other filter applied but not its own,
so ticking "Anvi" still shows how many "Meridian" products there are. One
grouped query per dimension, all in SQL.

```json
{
  "categories":    [ { "value": "kitchen", "label": "Kitchen", "count": 41 } ],
  "subcategories": [ { "value": "bottles", "label": "bottles", "count": 12, "parent": "kitchen" } ],
  "brands":        [ { "value": "Anvi", "label": "Anvi", "count": 9 } ],
  "sizes":         [ { "value": "M", "label": "M", "count": 4 } ],
  "colors":        [ { "value": "Red", "label": "Red", "count": 3, "hex": "#cc0000" } ],
  "priceRange":    { "min": 99.0, "max": 4999.0 },
  "priceBuckets":  [ { "min": 0, "max": 500, "label": "Under ₹500", "count": 10 },
                     { "min": 500, "max": 1000, "label": "₹500 – ₹1,000", "count": 7 },
                     { "min": 1000, "max": 2000, "label": "₹1,000 – ₹2,000", "count": 5 },
                     { "min": 2000, "max": 5000, "label": "₹2,000 – ₹5,000", "count": 3 },
                     { "min": 5000, "max": null, "label": "Over ₹5,000", "count": 1 } ],
  "ratings":       [ { "value": "4", "label": "4★ & above", "count": 20 }, { "value": "3", "label": "3★ & above", "count": 30 } ],
  "discounts":     [ { "value": "10", "label": "10% or more", "count": 15 }, "... 20, 30, 40, 50" ],
  "availability":  { "inStock": 35, "outOfStock": 6 },
  "attributes": [
    { "code": "material", "label": "Material", "type": "multi", "unit": "",
      "options": [ { "value": "steel", "label": "Steel", "count": 8 }, { "value": "glass", "label": "Glass", "count": 3 } ],
      "range": null },
    { "code": "capacity", "label": "Capacity", "type": "number", "unit": "ml", "options": [],
      "range": { "min": 250, "max": 1500 } },
    { "code": "dishwasher_safe", "label": "Dishwasher safe", "type": "boolean", "unit": "",
      "options": [ { "value": "true", "label": "Yes", "count": 6 }, { "value": "false", "label": "No", "count": 2 } ],
      "range": null }
  ]
}
```

- `priceRange` is computed over the **scope** only (search term, collection; categories when the page is a category page and no other filter), so the price slider's bounds don't jump while filters are ticked. It is `{0, 0}` for an empty scope.
- `priceBuckets` are fixed presets, counted with every filter except price.
- Only `active`, `filterable` attributes with at least one value in the result set are listed, in `position` order.

### `GET /api/search/suggest?q=&limit=5`

Lightweight (no full product payloads), rate-limited 240 per minute per IP.

```json
{
  "query": "bot",
  "correctedTerm": null,
  "products":   [ { "id": "PRD007", "slug": "steel-bottle", "name": "Steel Bottle", "brand": "Anvi",
                    "image": "https://…", "price": 499.0, "originalPrice": 699.0 } ],
  "categories": [ { "slug": "kitchen", "name": "Kitchen" } ],
  "brands":     [ { "value": "Botanica", "label": "Botanica" } ],
  "popular":    [ "steel bottle", "lunch box" ]
}
```

- `q` blank or under 2 characters: only `popular` is filled.
- `limit` 1–10 (products), default 5. Categories and brands up to 4 each.
- When nothing matches `q`, the dictionary correction is tried and `correctedTerm` says so.
- **Recent searches are kept in the browser** (`localStorage`, last 8), never sent.
- Suggestions are not logged as searches.

### `POST /api/search/click`

```json
{ "searchId": 812, "productId": "PRD007", "position": 3 }
```

→ `202 { "recorded": true }`. `position` is 1-based over the whole result list
(page 2's first item is `pageSize + 1`). Ignored (`recorded: false`) for an
unknown or older-than-24-hours search, an unknown product, or a repeat of the
same click. Rate-limited 120 per minute per IP.

## 6. API contract: admin

### Products list: `GET /api/admin/products` (any admin)

Takes every storefront parameter above, plus:

| Parameter | Meaning |
|---|---|
| `status` | `active` · `draft` · `out-of-stock` · `archived` · `all` (default all) |
| `stock` | `in-stock` (available above the low-stock threshold) · `low-stock` (1 … threshold available) · `out-of-stock` (none available) |
| `sort` | every storefront sort, plus `name-asc` · `name-desc` · `stock-asc` · `stock-desc` · `updated` · `category` · `status` |
| `search` | also matches the barcode |

`pageSize` ≤ 100. Response:

```json
{ "success": true, "data": [ "AdminProductOut…" ], "pagination": { "...": "" },
  "counts": { "all": 140, "active": 120, "draft": 12, "out-of-stock": 6, "archived": 2 },
  "filters": { "categories": [ { "value": "kitchen", "label": "Kitchen" } ], "brands": [ "Anvi", "Meridian" ] } }
```

`counts` respect every filter except `status`.

### Attributes (`products`)

Attribute object:

```json
{ "id": 3, "code": "material", "label": "Material", "type": "multi", "unit": "",
  "filterable": true, "searchable": true, "position": 1, "status": "active",
  "options": [ { "id": 7, "value": "steel", "label": "Steel", "position": 0 } ],
  "productCount": 18, "createdAt": "…", "updatedAt": "…" }
```

- `GET /api/admin/attributes?status=active|archived|all` (default all) → `[attribute]`, ordered by `position`, `label`.
- `POST /api/admin/attributes` `{ code, label, type, unit?, filterable?, searchable?, position?, status?, options?: [{ label, value? }] }` → 201.
  - `code`: lower-case letters, digits and `_`, 2–40, starting with a letter; unique (409 `ATTRIBUTE_CODE_TAKEN`).
  - `options` only for `select` / `multi` (422 `OPTIONS_NOT_ALLOWED` otherwise); ≤ 200; `value` defaults to the slug of the label; duplicates refused (422 `DUPLICATE_OPTION`).
- `GET /api/admin/attributes/{id}` → attribute (404 `ATTRIBUTE_NOT_FOUND`).
- `PUT /api/admin/attributes/{id}` same body, all optional.
  - `options`, when sent, is the whole list: entries with an `id` are renamed, without one are added, missing ones are removed — refused while a product uses it (409 `OPTION_IN_USE`).
  - Changing `type` or `code` is refused once any product has a value (409 `ATTRIBUTE_IN_USE`).
- `DELETE /api/admin/attributes/{id}`: refused while any product has a value (409 `ATTRIBUTE_IN_USE`; archive it instead).

### Product attribute values (`products`)

- `GET /api/admin/products/{productId}/attributes` →

```json
{ "productId": "PRD007",
  "attributes": [ { "id": 3, "code": "material", "label": "Material", "type": "multi", "unit": "",
                    "options": [ { "id": 7, "value": "steel", "label": "Steel", "position": 0 } ],
                    "value": [ "steel" ] },
                  { "id": 4, "code": "capacity", "label": "Capacity", "type": "number", "unit": "ml",
                    "options": [], "value": 750 },
                  { "id": 5, "code": "dishwasher_safe", "label": "Dishwasher safe", "type": "boolean",
                    "unit": "", "options": [], "value": true } ] }
```

  Every active attribute is listed; `value` is `null` when unset (`[]` for multi). `select` values are a single option value string.
- `PUT /api/admin/products/{productId}/attributes` `{ "values": { "material": ["steel","glass"], "capacity": 750, "dishwasher_safe": true, "colour_family": null } }` → the same shape.
  - Only the codes sent change; `null` (or `[]`) clears one.
  - `select`: one known option value; `multi`: known option values, ≤ 30; `number`: finite, |n| ≤ 1,000,000,000; `boolean`: true/false.
  - Errors: 404 `PRODUCT_NOT_FOUND`; 422 `UNKNOWN_ATTRIBUTE`, `INVALID_ATTRIBUTE_VALUE`.
  - Refreshes the product's `search_text` and the term dictionary. Audited.

### Search analytics (`search`)

`GET /api/admin/search/analytics?range=7d|30d|90d` (default 30d):

```json
{ "range": "30d", "from": "2026-09-03", "to": "2026-10-02",
  "totals": { "searches": 1240, "uniqueTerms": 410, "zeroResultSearches": 96, "zeroResultRate": 7.7,
              "clicks": 610, "ctr": 49.2, "conversions": 83, "conversionRate": 6.7 },
  "topSearches": [ { "term": "steel bottle", "searches": 88, "clicks": 51, "ctr": 58.0, "conversions": 9, "avgResults": 14.0 } ],
  "zeroResults": [ { "term": "air fryer", "searches": 12, "lastSearchedAt": "2026-10-02" } ],
  "trending":    [ { "term": "diwali lamp", "searches": 40, "previous": 6, "change": 566.7 } ],
  "series":      [ { "date": "2026-09-03", "searches": 37, "zeroResults": 3, "clicks": 18 } ] }
```

Read from `search_daily_stats` (today included: the job refreshes today on every pass, and the report refreshes today itself before reading). Lists are up to 20 entries. `trending` compares the range with the same length before it (terms with at least 3 searches).

`GET /api/admin/search/settings` →

```json
{ "popularMode": "curated", "popularSearches": [ "steel bottle" ], "autoPopular": [ "lunch box" ],
  "synonyms": [ [ "tee", "t-shirt", "tshirt" ] ], "lastRebuildAt": "2026-10-02T03:00:00", "dictionarySize": 2310 }
```

`PUT /api/admin/search/settings` `{ popularMode?, popularSearches?, synonyms? }` → the same.
`popularSearches` is the curated list (stored in `content.popularSearches`, ≤ 20, each ≤ 60 chars).
Audited.

`POST /api/admin/search/rebuild` → `{ "terms": 2310, "products": 140, "unitsSold": 140 }`. Audited.

### Dashboard summary

`app.services.search.analytics.summary(db)` →
`{ "searchesToday": 52, "zeroResultSearchesToday": 4, "topSearches": [ { "term": "steel bottle", "searches": 9 } ] }`.

## 7. Conversion, simply

A **click** is converted when the clicked product is added to the bag by the
same signed-in customer within **30 minutes** of the click, or appears on an
order that customer placed within **24 hours** of it. Guests' clicks are
counted as clicks; they convert only once the shopper is signed in (the bag is
an account feature). The job marks conversions; the report counts them.
CTR = searches with at least one click ÷ searches.

## 8. Background job `search` (every 10 minutes)

1. Recompute `search_daily_stats` for today and yesterday (idempotent upsert).
2. Mark conversions for clicks in the last 25 hours.
3. Every 6 hours (or when the dictionary is empty): rebuild the term dictionary,
   every product's `search_text`, and `units_sold`.
4. Delete raw `search_queries` older than `SEARCH_LOG_RETENTION_DAYS` (default 180); aggregates are kept.

## 9. Frontend

| Page | Route |
|---|---|
| Shop, category, collection, search | `/shop`, `/category/[slug]`, `/collection/[slug]`, `/search?q=` — sidebar on desktop, drawer with an Apply button on mobile, chips, clear all, counts, sort, pagination |
| Attributes | `/admin/attributes` (Catalogue, after Collections) |
| Search analytics + settings | `/admin/search` (Overview, after Analytics) with a Settings tab |
| Product attributes | an "Attributes" section on the product edit page |

What is built:

- **Storefront listing** (`components/products/ProductListing.tsx`, `components/filters/FilterPanel.tsx`, `ActiveFilterChips.tsx`): the request and the facets share one parameter builder (`listingParams` in `services/adapters/http-adapter.ts`), so counts always reflect what is ticked. Server ratings, discounts and price buckets (falling back to site content), an availability section, and dynamic attribute sections (checkboxes with counts for select / multi / boolean, min–max with Apply for numbers); zero-count options are disabled unless selected. The mobile drawer edits a draft with its own facet request and applies it in one push ("Show N results"). Sorts come from `lib/filters/sort-options.ts`: exactly the 11 the backend accepts; relevance is offered, and is the default, only with a search term.
- **Search page** (`components/search/SearchView.tsx`): the "Showing results for … — you searched for …" banner (`SearchCorrection.tsx`), popular searches on zero results (`PopularSearches.tsx`), and click tracking — one handler around the grid posts `POST /search/click` with a 1-based position across pages, as a keepalive fetch that never blocks navigation.
- **Search overlay** (`components/navigation/SearchOverlay.tsx`): `GET /search/suggest` (debounced, stale requests aborted) with products, categories, brands, "Did you mean" and "See all results"; before typing, recent searches (`lib/search/recent-searches.ts`, this browser only, last 8, cleared on sign-out) and popular searches; combobox ARIA with arrow keys, Enter and Escape. The visitor id is the existing `dcz:visitor` (`lib/search/visitor.ts`), sent only with a search term.
- **Portal:** `/admin/attributes` (`components/admin/views/search/AdminAttributesView.tsx`, `AttributeDialog.tsx` — code checked against the server's rule and locked once in use, options editor, archive / restore / delete with "Archive instead"), `/admin/search` (`AdminSearchView.tsx`: Analytics tab with range, tiles, daily charts, top / zero-result / trending tables; Settings tab with popular mode, curated list, synonym groups and "Rebuild now"), the product form's Attributes section (`ProductAttributesPanel.tsx`, edit only, its own Save), and the products list paging, searching, filtering and sorting on the server.

URL keys (backward compatible): `category`, `subcategory`, `brand`, `size`,
`color`, `minPrice`, `maxPrice`, `minRating` (also accepts `rating`),
`minDiscount`, `inStock=1`, `availability`, `q`, `sort`, `page`, `pageSize`,
plus `attr.<code>=a,b`, `attr.<code>.min`, `attr.<code>.max`. Filters change
the URL with the client router (`replace` for typing, `push` for filter
changes), so back/forward work and nothing reloads. Today every input commits on blur, Enter or Apply, so nothing uses `replace` yet.

## 10. Configuration

| Variable | Default | |
|---|---|---|
| `SEARCH_BACKEND` | `mysql` | which `SearchBackend` |
| `SEARCH_LOG_RETENTION_DAYS` | `180` | raw search log retention |

## 11. Testing

```bash
cd backend
TEST_DATABASE_NAME=dcz_d pytest tests/integration/test_search_listing.py tests/integration/test_search_admin.py tests/integration/test_attributes_api.py tests/unit/test_search_rules.py
TEST_DATABASE_NAME=dcz_d pytest tests/integration/test_catalogue.py tests/integration/test_catalogue_extra.py

cd ../frontend
npx vitest run src/components/filters src/components/search src/components/navigation src/components/products src/lib/filters src/lib/search src/components/admin/views/search src/services
npx tsc --noEmit -p .
```

## 12. Troubleshooting

- **A product doesn't come up for its category or attribute name**: its `search_text` is stale. Save the product, or Admin → Search → Settings → *Rebuild now*.
- **"Did you mean" never appears**: the dictionary is empty on a fresh install until the first job pass or a rebuild.
- **Best-selling order looks wrong**: `units_sold` is refreshed every 6 hours; *Rebuild now* refreshes it immediately.
- **Material**: the existing free-text `material` field is still searched. To make it a filter without a migration, create a `material` attribute (multi) and fill it on products; the free-text field can be retired later.
