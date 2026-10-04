# ID lookup

Every record is found, picked and filtered by its **ID**. Names, emails, phone
numbers and slugs are shown once a record has been identified, but they never
identify it.

- Backend: `app/services/lookup/`
  - `registry.py`: which entities exist, their ID columns, and who may look
    them up.
  - `service.py`: suggestions and exact resolution.
  - `previews.py`: the short card for each entity.
  - `filters.py`: exact-ID conditions for list endpoints.

  Routes are in `app/api/routes/lookup.py`.
- Frontend: the shared components in `frontend/src/components/common/`:
  - `IdAutocomplete`: the combobox.
  - `IdSelector`: one relationship field.
  - `IdMultiSelect`: several IDs, shown as chips.
  - `IdPreviewCard`.
  - `IdLink`.

  Lists use `components/admin/ui/IdFilter`. The service is
  `services/lookupService.ts`; labels and links are in `lib/lookup/entities.ts`.
- Portal page: `/admin/lookup?entity=order&id=DCZ10241`. Any ID can link here.
  The header's global search opens it.

## What counts as an ID

The formats already in use are unchanged. No ID was migrated.

| Kind | Example | Where it comes from |
|---|---|---|
| Business id | `PRD001`, `CUS001`, `ORD001`, `SUP001` | `app/utils/ids.py` (`PREFIXES`, three-digit minimum) |
| Order number | `DCZ10241` | `core/numbering.py` |
| Yearly document numbers | `DCZ-INV-2026-000001`, `DCZ-RF-…`, `DCZ-CN-…`, `DCZ-SH-…`, `DCZ-PO-…`, `DCZ-GRN-…`, `DCZ-PKG-…`, ticket `DCZ-2026-000001` | `core/numbering.py` |
| Codes | SKU, coupon code, supplier code, courier code, pincode, referral code | unique columns |
| Gateway ids | payment `transaction_id`, refund `gateway_reference`, webhook `event_id`, AWB, reconciliation `gateway_payment_id` | unique or indexed columns |
| Integer keys | segment, campaign, flash sale, bundle, question, stock adjustment, packing job, reconciliation, support agent; gift card shown as `GC12` (also `GC-000012`) | primary key |

Each registry entry lists its ID columns. The first is the ID people read; the
rest also find the record, and a suggestion says which one matched
(`PRD003 · matched DCZ-EL0003`).

These are never ID columns: name, email, phone, slug, title, subject or
description. A unit test (`test_id_lookup_rules.py`) enforces this.

## Two requests, never mixed

1. **Suggest**: `GET /api/admin/lookup/{entity}?q=PRD-00&limit=10`
   - Returns `{items: [{id, match?}], hasMore}`: identifiers only.
   - The limit defaults to 10 and is capped at 20.
2. **Resolve**: `GET /api/admin/lookup/{entity}/{id}`
   - Matches exactly one ID (`PRD001` never returns `PRD0010`).
   - Returns the preview: `title`, `subtitle`, `status`, `image`, `fields`
     (money is always in paise) and `related` (the IDs this record points at).
   - Also returns `key`, the value the record's own screen opens with
     (`?id=`).

The global search is `GET /api/admin/lookup?q=…&perEntity=3`. It groups
results by entity and only searches entities the role may open.

Customers have `GET /api/account/lookup/{order|invoice|refund|return|ticket|address}`.
Every query there is scoped to `customer_id = <signed-in customer>`.

## Matching rules

- **Normalised the same way everywhere.** Spaces are removed, letters are
  upper-cased and a leading `#` is dropped. Text that no ID could contain is
  refused with a 422 `LOOKUP_INVALID_ID`, for example `%`, `@` or `'`.
- **Prefix.** `col LIKE 'PRD00%'` is a range read on the column's unique
  index. `%` and `_` in the input are escaped.
- **Business ids** ignore dashes (`PRD-001` = `PRD001`). Bare digits try the
  entity's own prefix and its padding: `7` matches `PRD007…` and `PRD7…`.
- **Yearly numbers** also match their running number anywhere (`000123`),
  but only once at least three digits are typed. A leading wildcard cannot
  use the index to seek, so this match scans. That cost is why it waits for
  three digits.
- **Integer keys**: `12` matches 12, 120–129, 1200–1299 and so on. Each is a
  primary-key range.
- **Skipped columns.** A column whose values cannot start with the typed text
  (`ORD…` against `PRD…`) is skipped without a query. This keeps the global
  search to a handful of indexed reads.
- **Ranking.** Exact matches come first, then prefix matches, then shorter
  IDs, then the rest in order.

List endpoints use `filters.id_condition(entity, q)`: exact equality on the
entity's ID columns, or on a foreign key through `column=` and `via=`. A
value that is not ID-shaped matches nothing rather than erroring.

## Who may look up what

- **Admin.** Each entity's `access` mirrors the read guard of that area's
  own screens, and `require_access` semantics apply (stored or current role
  permissions):
  - Customers and addresses need `customers` or `orders`.
  - Suppliers need `suppliers` or `purchasing`.
  - Orders, products and billing are open to every administrator, as their
    own lists are.
- **Support tickets** use the desk's rule (`tickets.can_work`). An agent
  without `support` sees their team's tickets and the tickets assigned to
  them.
- **Out of reach looks the same as missing.** An unknown ID and one outside
  the caller's reach both return 404 `{Entity} ID X was not found.`
- **Previews never carry secrets.** No password hashes, tokens, gateway
  payloads, courier credentials, full gift-card codes or backup locations.
  Customer previews leave out portal-only links and internal notes.
- **Rate limit.** 240 lookups a minute per account, then 429.

## Frontend behaviour

- `IdAutocomplete` is a WAI-ARIA combobox: `aria-expanded`,
  `aria-activedescendant`, a polite live status and labelled options.
  - Arrow keys move through the list and wrap; Enter picks.
  - Enter with nothing highlighted checks the typed text as an exact ID.
  - Escape closes the list; a second Escape clears the text.
- Requests are debounced (250 ms), and stale requests are aborted, not
  ignored.
- Messages:
  - while searching: "Searching IDs…";
  - no matches: "No matching IDs found." (never the typed word);
  - not found: "Product ID PRD999 was not found.";
  - errors (401, 403, 409, 422, 429, 5xx, timeout, offline) use
    `lib/lookup/errors.ts`, which never shows server internals.
- After a pick, `IdPreviewCard` fetches the exact ID. It shows "Loading
  details…", then the main facts, the related IDs (each opens its own
  preview), "View full details", Change and Clear.
- **Caching.** Previews of slow-moving entities (category, supplier, courier
  and similar) are reused for 60 s. Volatile ones (stock, order, payment and
  shipment status) are always fetched fresh.
- The list is as wide as the field and scrolls inside itself, so it never
  overflows a phone screen.

## Adding an entity

1. Add an `Entity(...)` in `registry.py`: its ID columns, `access`, and an
   example.
2. Add a preview in `previews.py` with the main facts only.
3. Add a matching key in `frontend/src/lib/lookup/entities.ts`, with its
   label, example, admin href and whether it is volatile.
4. Make sure every ID column is unique or indexed.
