# Virtual try-on

Customers whose plan includes it upload a photo and see a product on
themselves. The store decides which plans include it and how much, which
products can be tried on, which AI models run each kind of try-on, and which
credentials pay for them. Every rule is enforced on the server.

- Backend: `backend/app/services/try_on/` (one module per concern, each with a
  docstring stating its rules), routes in `backend/app/api/routes/try_on.py`,
  models in `backend/app/models/try_on.py`, migration
  `alembic/versions/20261010_1000_virtual_try_on.py`.
- Storefront: `frontend/src/components/tryon/` (button, dialog, compare
  slider, browse page), `components/account/AccountTryOnView.tsx`, service
  `services/tryOnService.ts`.
- Portal: `frontend/src/components/admin/views/tryon/`, service
  `services/admin/tryOnAdminService.ts`. Admin → Storefront → Virtual try-on.

## How it fits together

```
catalogue category / subcategory ──mapping──▶ capability (garment.upper_body, eyewear.frames, …)
product setting (override / opt out) ────────┘     │ photo rules, guidance, status
                                                    ▼
model (adapter + endpoint config + capabilities, enabled + verified) ◀── provider (huggingface, …)
                                                    ▲
credential (encrypted; shared, or dedicated to one customer) ── usable for some models / kinds / categories

customer ─▶ entitlement (membership plan │ allocation │ trial) ─▶ quota ledger
         ─▶ photo (validated, re-encoded, private storage)
         ─▶ request ─▶ queue ─▶ worker ─▶ adapter ─▶ result ─▶ storage (S3 or ephemeral)
```

### Capabilities, not clothing

A **capability** is one kind of try-on with its own photo requirements:
`garment.upper_body`, `garment.lower_body`, `garment.dress`, `eyewear.frames`,
`eyewear.sunglasses`, `wrist.watch`, `bag.carry`, `footwear.shoes`,
`jewellery.general`. Each is `enabled`, `disabled` or `coming_soon`. Customers
see "Try it on" only when it is enabled **and** at least one enabled,
**verified** model of an enabled provider supports it. Otherwise they see
"coming soon", or nothing. A model is never asked to do something it isn't
registered for, and a model can't be registered for more than its adapter can
do.

Out of the box:

| Capability | Status | Model |
| --- | --- | --- |
| Tops, shirts and jackets (`garment.upper_body`) | enabled | OOTDiffusion half body (`/process_hd`), enabled and verified (the call the earlier stand-alone service made) |
| Trousers, jeans, skirts; dresses | disabled | OOTDiffusion full body (`/process_dc`), registered, **disabled and unverified** |
| Spectacles, sunglasses, watches, bags, shoes, jewellery | coming soon | none |

To offer try-on on products: **Models & categories → Categories**, map a
category (or one of its subcategories) to a capability. A product can override
its category or opt out (`PUT /api/admin/try-on/products/{id}/setting`).

### Providers, models, adapters

An **adapter** is code (`services/try_on/adapters/`) that knows how to call
one family of endpoints, which capabilities it can handle at most, how to check
a credential, and how to turn the provider's errors into the codes below.
Providers and models are rows the portal edits. The Hugging Face adapters use
`gradio_client`, with a deadline on every call (`Client.submit` plus
`job.result(timeout)`, cancelled on timeout), a working folder per call that is
deleted afterwards, and credential checks through Hugging Face's `whoami-v2`
(no GPU time spent).

`mock.overlay` pastes the product photo onto the customer's photo. It runs the
whole flow without AI credits, and is refused in production.

**Verifying a model:** Models → **Test** runs one generation with photos you
upload, stores nothing, and shows the result. Once it looks right, mark the
model **verified** and **enabled**.

### Credentials

- Encrypted at rest (Fernet; key from `VTO_ENCRYPTION_KEY`, never in the
  database or the code). The API never returns a saved token, only
  `••••••••abcd`. Audit entries name the credential, never the secret.
- **States:** healthy, not checked yet, failing (3+ consecutive credential
  failures), invalid (the provider rejected it), rate limited (resting until a
  time), disabled, deleted. *Hidden* only keeps it out of the list: a hidden
  credential is still used.
- **Assigned to** models, capabilities (only those its models support) and
  catalogue categories. Empty means any. Daily and monthly limits are optional.
- **Rotation:** "Replace token" keeps the credential's history. Key rotation:
  set the new `VTO_ENCRYPTION_KEY`, move the old one to
  `VTO_ENCRYPTION_KEY_PREVIOUS`, press **Re-encrypt now**, then remove the old
  key.
- **Deletion** erases the secret and keeps the row, so reports still name it.
- A real call that fails with *invalid credentials* marks the credential
  invalid and alerts staff. A *rate limit* rests it for the provider's wait
  time (or the provider's cooldown setting). Housekeeping revives it afterwards
  and re-checks every credential about once a day.

### Which credential runs a request (`selection.py`)

For each eligible model (best priority first; a customer's quality choice
first when their plan allows choosing), every credential that is:

- not deleted, readable, not disabled or invalid, not resting;
- under its limits;
- for that model, capability and category;
- **shared and auto-selectable**, or **dedicated to this very customer with an
  active allocation naming it**.

Dedicated credentials come first for their owner, then by priority, then the
least recently used. A failure moves on in a way that fits its cause:

- a credential failure → the next credential;
- a model failure → the next model;
- a provider failure → the next provider;
- a problem with the request itself → stop.

Customers never send a credential id. Isolation is enforced in that one
function, whatever the request says.

## Entitlements and quota (`entitlements.py`)

| Source | Where it's set | Resets |
| --- | --- | --- |
| Membership plan | Virtual try-on → Plan entitlements (or `tryOn` on the existing plan API) | Every membership month, counted from the membership's start — the same rhythm as free deliveries |
| Allocation | Access & allocations (approving a customer's request, or directly) | Its own total / per-day limit, between its dates |
| Trial | Settings: lifetime try-ons for customers with no qualifying plan | Never |

A plan's entitlement can set:

- on or off, per month, per day, at once (concurrent);
- kinds of item, quality tiers, largest photo;
- retention (temporary for N days, or permanent with an optional cap on saved
  results);
- download, retries per try-on, choosing quality, asking for more.

It is copied onto a membership when it is bought. A member who bought before
the plan included try-on gets the plan's current entitlement.

- **Only successes count.** A request reserves one unit and gives it back if it
  fails or is cancelled.
- **No double charging.** The storefront sends an `Idempotency-Key` per press,
  and the same key always returns the same request.
- **Limits hold under simultaneous requests.** Reserving locks the customer's
  row, so simultaneous requests are counted one after another.
- **Checked again when the worker starts.** If a membership ended (or an
  allocation was revoked) while the request was queued, it fails as
  *not eligible* and the unit is returned.
- **Abuse limits:** try-ons started per hour and photos uploaded per hour (in
  Settings).

## Images: storage and privacy (`storage.py`, `images.py`)

**Nothing is kept on the application server.** Two backends, chosen by
`VTO_STORAGE`:

- **s3**: a private bucket or prefix (`VTO_S3_PREFIX`, which must not sit
  inside the public product-photo prefix), server-side encrypted, `no-store`.
  Results are read through the API or through signed links that last
  `VTO_SIGNED_URL_SECONDS`. No object is public.
- **ephemeral**: the mode until S3 is configured. Files are Fernet-encrypted in
  an isolated folder and deleted after `VTO_EPHEMERAL_TTL_MINUTES`; the
  housekeeping job also removes any file older than that, whatever the
  database says. Customers are told results are *not saved*. Suitable for one
  server, or several sharing that folder; configure S3 before scaling out.

`auto` (the default) uses S3 when it works, otherwise ephemeral. Switching to
S3 is configuration only. Every stored object records which backend holds it.

| Plan retention | Stored as | Deleted |
| --- | --- | --- |
| permanent (S3) | `permanent` | when the customer deletes it; a membership that ends moves it to temporary with `lapsedGraceDays` |
| temporary (S3) | `temporary` | after the plan's days (customers are reminded beforehand) |
| any, without S3 | `ephemeral` | after the TTL |

- **Photos** must decode as JPEG, PNG or WebP. They are limited in bytes, and
  in pixels before decoding (decompression bombs are refused), turned upright,
  stripped of all metadata (GPS included), scaled to 1536 px at most and
  re-encoded. Unsaved photos live as long as their result, or about 2 hours
  when unused. Saved photos ("save for my next try-on") follow the plan's
  retention.
- **Product photos** are fetched by the server over http(s) only, from public
  addresses in production, with size limits.
- **Deleting** hides the try-on at once and deletes its result and (unsaved)
  photo. Storage that refuses is retried with backoff (`vto_cleanup_tasks`,
  visible in Settings) until it confirms; nothing is reported as gone while it
  is still there.
- Image data, signed URLs and secrets are never logged. The database holds
  object keys and metadata only.

## Failures, as people read them (`errors.py`)

Every failure has a code, a badge, a sentence for the customer, a sentence for
the administrator, whether it can be retried, and sanitised technical detail.
Sanitising removes `hf_…` tokens, bearer tokens, query strings and file paths.

| Code | Badge | Administrator sees |
| --- | --- | --- |
| `invalid_credentials` | Invalid Credentials | The AI service rejected the configured credentials. |
| `rate_limited` | Rate Limited | This AI service is temporarily busy. |
| `timeout` | Timed Out | Image generation took too long. |
| `unsupported_category` | Unsupported Category | This AI model does not support the selected clothing type. |
| `invalid_image` / `image_too_large` / `image_too_small` | Invalid Image / Image Too Large / Image Too Small | The uploaded image… |
| `provider_unavailable` | Provider Unavailable | The AI service is temporarily unavailable. |
| `no_capacity` | No Capacity | No enabled, healthy credential could run this request. |
| `plan_ineligible` | Not Eligible | This subscription does not include Virtual Try-On. |
| `limit_reached` / `concurrency_limit` | Limit Reached | You have reached your Virtual Try-On limit. |
| `storage_unavailable`, `garment_unavailable`, `bad_provider_response`, `lease_lost`, `unknown` | … | … |

The request log filters by status, failure, provider, model, customer and
date. The detail page shows every attempt.

## The queue (`worker.py`, `jobs.py`)

`POST /api/try-on/requests` answers 202 at once. Each server process runs a
worker that claims queued requests with `SELECT … FOR UPDATE SKIP LOCKED` and a
lease, so several processes share the queue. It runs up to
`VTO_WORKER_CONCURRENCY` generations in threads; web workers never wait on an
AI call. The storefront polls `GET /api/try-on/requests/{id}` every 2 seconds,
showing queue position and an estimate. A request whose process died is
re-queued once, then failed.

Housekeeping (`jobs.try_on`, every `VTO_HOUSEKEEPING_INTERVAL_SECONDS`) handles
expiry, abandoned photos, cleanup retries, stale leases, permanent results of
lapsed members, cooldowns, allocation expiry, credential checks and reminders.

## Permissions

| What | Permission |
| --- | --- |
| Dashboard, requests, models and categories, plans, allocations, settings | `try-on` (super admin, admin, manager) |
| Credentials, provider health checks, model tests | `try-on-credentials` (super admin, admin) |

## API

Shoppers (`/api/try-on`):

| Endpoint | What it does |
| --- | --- |
| `catalogue` (public) | What can be tried on; drives the badges and buttons |
| `eligibility`, `usage` | The shopper's allowance and how results are kept |
| `products`, `products/{id}` | Products that can be tried on; the panel for one product |
| `photos` (POST multipart, GET, DELETE) | The shopper's photos |
| `requests` (POST with `Idempotency-Key`, GET), `requests/{id}` | Start a try-on, the history, one try-on |
| `requests/{id}/retry`, `/cancel`, `/image?which=result\|original`, `/download`, `/favourite`, `/feedback`, DELETE | Acting on one try-on |
| `access-requests` (GET, POST, `{id}/withdraw`), `allocations` | Asking for more, and what was granted |

Store (`/api/admin/try-on`):

| Endpoint | What it does |
| --- | --- |
| `overview` | The dashboard; filters `from`, `to`, `providerId`, `modelId`, `credentialId`, `customerId`, `planId`, `capability`, `categoryId`, `status`, plus `granularity` |
| `requests`, `requests/{id}`, `requests/{id}/requeue` | The request log, one request, running it again |
| `settings`, `storage`, `cleanup`, `cleanup/run` | Settings, storage status, deletions waiting |
| `capabilities`, `mappings`, `products/{id}/setting` | What can be tried on, and where |
| `adapters`, `providers` (+ `{id}/check`), `models` (+ `{id}/test`) | What runs it |
| `plans`, `plans/{id}` | Plan entitlements |
| `credentials` | Add, `bulk`, edit, `{id}/secret`, `{id}/enable` / `disable` / `hide` / `unhide` / `validate`, DELETE, `{id}/usage`, `reencrypt` |
| `access-requests` (+ `{id}/approve` / `reject`), `allocations` (+ `{id}/revoke`) | Customers' access |

## Configuration

All in `backend/.env.example` under "Virtual try-on". The ones that matter:

- `VTO_ENCRYPTION_KEY`: required to store or use credentials in production.
  The rest of the store runs without it.
- `VTO_STORAGE`, `VTO_S3_BUCKET`, `VTO_S3_PREFIX`, `VTO_S3_SSE`,
  `VTO_S3_KMS_KEY_ID`, and the store's `AWS_*` settings (or
  `AWS_USE_DEFAULT_CREDENTIALS=true` for an IAM role).
- `VTO_WORKER_CONCURRENCY`, `VTO_WORKER_LEASE_SECONDS`.
- Provider timeouts, retries and rest after a rate limit are per provider, in
  the portal.

### Configuring S3 later

1. Create a bucket (or reuse the store's) with **Block Public Access on**.
2. Give the server's role (preferred) or IAM user the least it needs, on the
   try-on prefix only:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::YOUR-BUCKET/try-on/*"
     }]
   }
   ```

   Add `kms:Encrypt`, `kms:Decrypt` and `kms:GenerateDataKey` on the key if you
   use `aws:kms`.
3. Optionally add a lifecycle rule that expires `try-on/photos/` after a few
   days as a safety net. The application deletes what it should on its own.
4. Set `AWS_S3_BUCKET` (or `VTO_S3_BUCKET`), `AWS_REGION`, and either the
   access keys or `AWS_USE_DEFAULT_CREDENTIALS=true`. Leave
   `VTO_STORAGE=auto`. Restart.
5. Admin → Virtual try-on → Settings shows "Private S3". Plans with permanent
   retention now keep results.

### Adding another provider or kind of try-on

1. Write an adapter in `backend/app/services/try_on/adapters/`: subclass
   `TryOnAdapter`, set `key`, `provider_kind` and `max_capabilities`, and
   implement `generate`, `check_credential` and `classify`. Register it in
   `adapters/__init__.py`.
2. A new kind of item (say `eyewear.frames`) already exists as a capability.
   Otherwise add one in the portal, with its photo rules and tips.
3. In the portal: add the provider (if new), then a model that uses the
   adapter, with its endpoint configuration and the capabilities it handles.
   Add credentials, **Test**, then mark it verified and enabled. Map
   categories to the capability.

Nothing else changes: selection, quota, storage, analytics and the storefront
work from those rows.

## Running it locally

1. Migrate (it happens on start-up with `AUTO_MIGRATE=true`). Head:
   `d0e1f2a3b4c5`.
2. Portal → Virtual try-on:
   - **Models & categories:** map a clothing category to *Tops, shirts and
     jackets*.
   - **Plan entitlements:** include try-on in a plan (or switch on the trial in
     Settings).
   - **Credentials:** add your Hugging Face token(s) — or, for an offline run,
     add a provider of type `mock` and a model using *Mock (development only)*
     for `garment.upper_body`, marked verified and enabled.
3. As a member, open a mapped product → **Try it on** → upload → the result
   appears beside your photo. Without S3 the result is ephemeral.
4. Watch it in **Overview** and **Requests**. Delete it from **Account →
   Virtual try-on**.

Tests use the mock adapter and fake gradio/HTTP clients; none reach Hugging
Face or S3:

- `backend/tests/integration/test_try_on.py`
- `backend/tests/unit/test_try_on_units.py`
- `frontend/src/components/tryon/TryOn.test.tsx`
- `frontend/src/components/account/AccountTryOnView.test.tsx`
- `frontend/src/components/admin/views/tryon/*.test.tsx`

## Deployment checklist

- [ ] `pip install -r backend/requirements.txt` (adds `gradio_client==1.14.0`).
- [ ] Set `VTO_ENCRYPTION_KEY` (32+ random characters), stored like the JWT
      secret.
- [ ] Run the migration on a copy of production first (it is additive), then
      production.
- [ ] Decide storage. Without S3, results are ephemeral; for several app
      servers, configure S3.
- [ ] Add credentials and press **Check** on each.
- [ ] Test the full-body model before enabling it.
- [ ] Map categories and set plan entitlements.
- [ ] Watch the `try_on` job in System health.

## Known limits

- OOTDiffusion handles upper-body garments well. The full-body endpoint is
  untested here. Accessories need models and adapters that don't exist yet,
  and are shown as "coming soon".
- Ephemeral storage is per host, as described above.
- The rate limiter is per process (as it is for the rest of the API).
- Per-provider cost is an estimate from the cost per call entered on a model.
  Hugging Face does not report spend per call.
