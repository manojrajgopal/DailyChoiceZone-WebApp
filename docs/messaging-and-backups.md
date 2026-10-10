# Reorder, campaigns, notifications, email templates and backups

How these parts of Daily Choice Zone work, how to set them up, and how to
run them. Code references are to `backend/app/…` unless they say otherwise.

- [Reorder](#reorder)
- [Notifications on every channel](#notifications-on-every-channel)
- [Email templates and the email design](#email-templates-and-the-email-design)
- [Marketing campaigns](#marketing-campaigns)
- [Database backups](#database-backups)
- [Environment variables](#environment-variables)
- [Setting it up](#setting-it-up)
- [Tests](#tests)

---

## Reorder

`services/reorder.py`, API in `api/routes/messaging.py`.

| Endpoint | What it does |
|---|---|
| `GET /api/orders/{id}/reorder` | Each line of the customer's own order: still sold? size and colour still exist? in stock? today's price, how many can be added, and why not. |
| `POST /api/orders/{id}/reorder` `{keys?}` | Adds what can be added (all lines, or the `keys` chosen) to the bag. |

- Every item goes through the bag's own `cart.add_item`, so the same checks
  apply as on the product page: product on sale, variant exists, stock, the
  per-line limit, a flash sale's per-customer limit.
- Nothing from the old order is reused except *what* was bought. Prices,
  coupons, delivery and tax are worked out by the bag as they are today.
  Nothing is ordered; the customer reviews the bag and checks out.
- A partial reorder is normal: what can be added is, and the rest is listed
  with its reason (out of stock, no longer sold, size gone, already in bag).
- Reordering twice doesn't double the bag: a line already there at the
  quantity ordered is reported as "already in your bag".
- A bundle is re-added as that bundle while it's still on sale.
- Another customer's order answers 404, the same as one that doesn't exist.
- Each reorder is recorded (`reorder_events`). Admin → Analytics → Customers
  shows reorders, conversion (an order within 7 days), the most reordered
  products and how many customers have bought more than once.

Storefront: **Order again** on each order in *Your orders*, on the order
page, and **Add to bag again** on single items.

## Notifications on every channel

`services/messaging/` — `catalogue.py` (events), `service.py` (the pipeline),
`providers.py` (SMS and WhatsApp providers).

```
business event (an order shipped)
  → email.notify(..., event="order_shipped", variables={...})
      → the event's template (the store's wording, or the built-in default)
      → email, plus SMS / WhatsApp where the store switched them on for it
      → the customer's consent for each channel
      → one NotificationDelivery row per channel, in the same transaction
  → after commit, a background worker sends each through its provider
  → transient failure: retried with exponential backoff (1, 2, 4, 8 … min, max 6 h)
  → after 5 attempts, or a permanent failure: "dead", with the reason, and staff alerted
```

- **Every existing email** still goes through `email.notify`; it now also
  records a delivery row (so failed emails retry) and fans out to other
  channels for the events in `catalogue.EVENTS`.
- **Idempotent.** Each delivery has an idempotency key (event, reference,
  channel, customer), unique in the database. Calling the same event twice,
  a webhook delivered twice, a worker restart: one message. A retry updates
  its own row.
- **Never faked.** A channel with no provider configured sends nothing; a
  delivery it would have made is recorded as `skipped` with the reason.
  `delivered`/`read` only come from the provider's own status webhooks.
- **Sign-in links stay in email.** Verification and reset emails can't be
  routed to SMS or WhatsApp, and their content is never stored for retry.
- **Transactional is not marketing.** Order, payment, refund, return, delivery
  and account messages never depend on marketing consent. SMS order updates
  are on by default for customers with a mobile number and can be turned off;
  WhatsApp needs the customer's opt-in (WhatsApp's policy).
- **Offers.** Offers by email and in the bell are on by default, for new and
  existing customers, until the customer turns them off: the sign-up box
  (ticked by default), Account → Settings → Notifications, or an unsubscribe
  link. A "no" is saved and always respected. SMS and WhatsApp offers stay
  opt-in.
- **The bell.** In-app notifications are the storefront bell
  (`CustomerNotification`), as before.

Events: order placed/confirmed, processing, packed, shipped, in transit, out
for delivery, delivered, cancelled, returned; payment received/failed;
refund initiated/completed; invoice; return requested/approved/rejected/
received; replacement initiated/shipped/delivered; welcome (after the email
is confirmed), email verification, password reset, password changed, sign-in
alert (off by default); membership activated/expiring (7 days)/expired;
support created/reply/status/resolved; abandoned bag; campaign message.

### Provider webhooks (delivery status)

| Provider | URL to configure | Verified with |
|---|---|---|
| Twilio (SMS and WhatsApp) | sent automatically as `StatusCallback` when `PUBLIC_API_URL` is set: `<PUBLIC_API_URL>/api/notifications/webhooks/twilio` | `X-Twilio-Signature` (auth token) |
| Meta WhatsApp Cloud | `<PUBLIC_API_URL>/api/notifications/webhooks/whatsapp`, subscribe to `messages` | GET challenge with `WHATSAPP_VERIFY_TOKEN`; POSTs with `X-Hub-Signature-256` (app secret) |

Unsigned or wrongly signed webhook calls are refused with 403.

### Admin → Notifications

- **Overview & channels**: each channel's status (configured or not and
  why, never credentials), the last week's counts, and which events also go
  by SMS and WhatsApp. A channel can't be switched on until its provider is
  configured.
- **Delivery history**: every message, filtered by channel, status, event,
  customer, date and text; recipient masked in lists; the detail shows the
  provider, its message id, attempts, reason and the content (never secrets);
  **Retry** on failed or skipped messages (same row, same idempotency key).
- **Templates**: see below.

The sidebar shows how many transactional messages failed for good.

## Store team alerts

Everything the team should hear about goes through one function,
`inbox.staff(...)` (`app/services/staff_alerts.py`), on every channel the store
has switched on in **Settings → Notifications → Store team alerts**:

| Channel | Who gets it |
|---|---|
| In the portal (the bell) | Administrators whose role covers the alert. Read is per administrator. |
| Email | The same administrators, skipping an address that can't receive mail, plus the **alert recipients**. If that leaves nobody, the store's sending mailbox gets it. |
| SMS | The alert recipients' phone numbers, through `NOTIFICATION_SMS_PROVIDER`. |
| WhatsApp | The same numbers, through `NOTIFICATION_WHATSAPP_PROVIDER`, using the approved template named in the settings. |

**Alert recipients** are up to 10 emails and 5 phone numbers that get every
alert, whatever the administrators' roles. Use addresses someone reads: an
administrator's address on a domain that doesn't exist is skipped, never
"sent". **Send test alert** sends one on every channel that is on, so you can
check before it matters.

What raises an alert, and its switch:

| Alert | Switch |
|---|---|
| New order (placed and confirmed, cash on delivery included); order cancelled, or its payment expired | Orders |
| A customer's payment failed; a payment webhook failed | Payments |
| A product on sale runs low (falls to its threshold) or runs out. Once per crossing, not on every sale | Low stock |
| A customer taps **Notify me** on an out-of-stock product (who, what, and how many are waiting now) | Notify me requests |
| One email each morning (after 09:00 IST): new requests, the most-wanted products, how many were told it's back. Not sent on a day with nothing to report | Daily waitlist summary |
| A review is waiting for approval | Reviews |
| A new customer account (sign-up form, Google/Apple/Microsoft, one-time code) | New customers |
| Refund, return, shipment, webhook, backup, health, campaign and delivery problems | none: always sent |

Each alert is its own delivery (its own idempotency key), so it's retried and
appears in Admin → Notifications → Delivery history. An SMS or WhatsApp alert
that can't go (no provider, no template) is recorded as **skipped** with the
reason, and **Retry** sends it once the provider is set up.

**WhatsApp template for alerts.** WhatsApp only lets a business start a
conversation with a template Meta has approved. Create one (category
*Utility*) with two body variables, for example:

```
Store alert: {{1}}
{{2}}
```

`{{1}}` is the alert's title; `{{2}}` its details and the link. Enter the
template's name and language in Settings → Notifications.

### Who is waiting ("Notify me")

**Stock & price alerts → Waiting customers** groups the active back-in-stock
requests by product and variant, most wanted first, with the stock now; **See
customers** lists each one with name, email and phone (CSV export included).
Products and Inventory show the count beside the stock, the product form
says how many are waiting, and the sidebar counts the customers waiting.

## Email templates and the email design

`services/email/templates.py`.

Every email — the existing ones and the new — is framed by one **master
layout**: the Daily Choice Zone logo (`frontend/public/brand/logo.png`, the logo
the website shows, attached to each email so it appears in every mail client), the store name and tagline, the title,
greeting and message, an optional button, and a footer with support contact,
website, shipping/returns/privacy/terms links and social links (from Store
settings). Marketing email adds an **unsubscribe** link and a preferences
link; transactional and security email don't.

Built for email clients:

- table layout, 600 px container, an Outlook-only fixed-width "ghost table";
- every style inline; the `<style>` block only *adds* phone-width rules and
  dark-mode colours for clients that support them;
- "bulletproof" buttons (padded link plus a VML shape for Outlook);
- Georgia headings, Helvetica/Arial text; hidden preheader text; images with
  alt text, so an email with images off still reads.

Components: `paragraph`, `button`, `details` (label/value rows), `items`
(order lines with image, quantity and amount, and a total), `note`.

### Templates in the portal

Admin → Notifications → Templates (also linked from Settings → Email → Templates & preview):

- each event's email subject, heading, message (plain text; blank line = new
  paragraph; `**bold**`), button label, SMS text, WhatsApp template and
  variables, in-app title and message;
- live **preview** (email rendered in a sandboxed frame, SMS with segment
  count, WhatsApp and in-app), **test send** to your own address or number,
  **enable/disable** (security messages can't be disabled), *Use built-in
  wording*, last changed and by whom;
- the order lines and details stay under the store's own wording.

### Variables

`{{customer_name}}`, `{{order_number}}`, `{{order_date}}`, `{{order_total}}`,
`{{payment_status}}`, `{{shipping_address}}`, `{{tracking_number}}`,
`{{tracking_url}}`, `{{order_url}}`, `{{product_name}}`, `{{membership_plan}}`,
`{{membership_expiry}}`, `{{support_request_number}}` and more, listed per
event in the editor.

`{{name}}` substitution only — no expressions, loops or attribute access.
Unknown names are refused when a template is saved; every value going into
HTML is escaped, so customer-entered text can't become markup. Campaign HTML
is passed through an allow-list sanitiser (no scripts, styles, event
handlers or `javascript:` links).

### Email log

The existing email history keeps working and now also records the template
(`email_log.template_key`) and its delivery record (`email_log.delivery_id`).
Bounces are still read by the bounce checker.

## Marketing campaigns

`services/messaging/campaigns.py`. Admin → **Campaigns** (marketing).

Types: promotional, product announcement, new arrivals, discount, flash
promotion, membership, abandoned bag, announcement (add more in `KINDS`).
Channels: email, SMS, WhatsApp, in-app.

**Audience filters**: every customer / members / not members / new / repeat /
lapsed; joined within N days; ordered between dates; not ordered for N days;
spent at least/at most; orders at least/at most; bought certain products or
categories; membership plan; has an abandoned bag. **Consent is always
applied on top**: a customer is sent on a channel only if they agree to
marketing on it (by default for email and the bell, by opting in for SMS and
WhatsApp), haven't turned it off, and can be reached there.

**The builder**: details → audience (live counts per channel) → content per
channel (with the type's starting text) → schedule (now or later) → review.

**Safety**:

1. the audience count is shown per channel before launch;
2. a test must be sent (to the admin's own address/number) after the last
   edit;
3. launching asks for confirmation and sends the message count the admin saw;
   if the audience has changed since, the launch is refused with the new
   figure;
4. channels must be configured, content complete, variables valid;
5. a campaign launches once (`launch_key` unique, under a row lock);
6. sending is done by the background job, one `CampaignRecipient` per
   customer and channel (unique) and one delivery each (own idempotency key),
   so a restart resumes without sending anyone the same message twice;
7. it can be cancelled before or while sending (unsent messages are dropped).

**Analytics** — only what each channel can report:

| | Email | SMS | WhatsApp | In-app |
|---|---|---|---|---|
| targeted, queued, sent, failed | ✓ | ✓ | ✓ | ✓ |
| delivered | not available | provider webhook | provider webhook | ✓ |
| opened | tracking image (needs `PUBLIC_API_URL`) | not available | read receipt | not available |
| clicked | tracked link | tracked link | not available | not available |
| unsubscribed | unsubscribe link | not available | not available | not available |
| bounced | bounce checker | not available | not available | not available |
| replied | not available | not available | inbound webhook | not available |

Revenue attributed: orders by a recipient within 7 days of clicking, or using
the campaign's coupon after launch. Links go through
`<STOREFRONT_URL>/r/<token>`, signed, so they can't redirect anywhere the
campaign didn't link to.

**Unsubscribe**: `<STOREFRONT_URL>/unsubscribe?token=…` (signed per customer
and channel), one click, no sign-in. Customers also manage consent in
Account → Settings → *Texts, WhatsApp and offers*, and can opt in to email
offers at sign-up (unticked by default).

## Database backups

`services/backups.py`, CLI `app/tools/backup.py`. Admin → Settings → **Backups**.

**How a backup is made**: a MySQL named lock (one backup at a time) → a
consistent snapshot (`START TRANSACTION WITH CONSISTENT SNAPSHOT`) dumped by
the app over its own connection (no `mysqldump`, no password on a command
line) → gzip → AES-256-GCM encryption in 1 MB chunks when
`BACKUP_ENCRYPTION_KEY` is set → SHA-256 → stored → **verified**: the stored
file is read back, its checksum compared, decrypted and decompressed end to
end, and its closing line must list every table dumped. Only then is it
marked *succeeded*.

**Storage**:

- `local` (default): `BACKUP_LOCAL_DIR`, default `backend/var/backups/`
  (git-ignored), outside anything the web servers serve; files `0600`.
- `s3`: `BACKUP_S3_BUCKET` (or `AWS_S3_BUCKET`) under `database-backups/`,
  `ACL=private`, server-side encryption — never the `products/` prefix.

**Schedule** (portal): every 6 hours, every 12 hours, daily or weekly, at a
set hour (India time) and weekday. **Retention**: daily backups kept N days,
weekly ones (the first of each week) N weeks, the last N manual ones; the
newest verified backup is never deleted. Expired backups are deleted from
storage and their record kept (status *Expired*).

**Failures** are recorded with the reason (credentials scrubbed), the store
team is alerted (admin tray and email), and System health shows it. A backup
interrupted by a restart is marked failed after 3 hours.

**Downloads**: the portal asks for a link that works for 5 minutes, for that
admin and that backup only (S3: a presigned URL). Downloads are in the audit
log. Backups are the super admin's unless the `backups` permission is granted.

### Restoring

Deliberately not a button: a restore over the live database is how a bad
backup becomes a lost shop.

```bash
cd backend
# 1. Check the file (checksum, every table present)
python -m app.tools.backup verify  BKP-20261005-020000-AB12.sql.gz.enc
# 2. Turn it into SQL (needs the BACKUP_ENCRYPTION_KEY it was made with)
python -m app.tools.backup decrypt BKP-20261005-020000-AB12.sql.gz.enc restore.sql
# 3. Load it into a NEW, empty database
mysql -u root -p -e "CREATE DATABASE dcz_restore CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mysql -u root -p dcz_restore < restore.sql
# 4. Check it (row counts, a few orders), then point DATABASE_NAME at it and restart the API.
```

Keep `BACKUP_ENCRYPTION_KEY` somewhere other than the server (a password
manager). Without it the backups can't be read.

## Environment variables

All optional; everything works with none of them set, with the channel or
feature reported as not configured.

| Variable | Used by | Required? | Example | What it does |
|---|---|---|---|---|
| `PUBLIC_API_URL` | campaigns, webhooks | for open tracking and delivery webhooks | `https://api.dailychoicezone.com` | The API's public address: the email tracking image and the Twilio status callback use it. |
| `NOTIFICATION_SMS_PROVIDER` | SMS | to send SMS | `twilio` | `none` (default) or `twilio`. |
| `NOTIFICATION_SMS_SENDER` | SMS | with twilio | `+14155550123` or `MG…` | A Twilio number, or a Messaging Service SID. |
| `TWILIO_ACCOUNT_SID` | SMS, WhatsApp via Twilio | with twilio | `AC…` | Twilio account. |
| `TWILIO_AUTH_TOKEN` | SMS, WhatsApp via Twilio | with twilio | secret | Also verifies Twilio's webhooks. |
| `NOTIFICATION_WHATSAPP_PROVIDER` | WhatsApp | to send WhatsApp | `meta` | `none` (default), `meta` (Cloud API) or `twilio`. |
| `NOTIFICATION_WHATSAPP_SENDER` | WhatsApp via Twilio | with twilio | `whatsapp:+14155238886` | The WhatsApp-enabled Twilio sender. |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp via Meta | with meta | secret | A system-user token for the WhatsApp Business Account. |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp via Meta | with meta | `1234567890` | The business phone number's id. |
| `WHATSAPP_APP_SECRET` | WhatsApp webhooks | with meta | secret | Verifies Meta's webhook signatures. |
| `WHATSAPP_VERIFY_TOKEN` | WhatsApp webhooks | with meta | a random string you choose | Answers Meta's webhook verification. |
| `WHATSAPP_API_VERSION` | WhatsApp via Meta | no | `v20.0` | Graph API version. |
| `BACKUP_STORAGE` | backups | no | `local` / `s3` | Where backups are kept. |
| `BACKUP_LOCAL_DIR` | backups | no | `/var/lib/dcz/backups` | Local folder (default `backend/var/backups`). |
| `BACKUP_S3_BUCKET` | backups | with s3 | `dcz-private-backups` | Bucket (default `AWS_S3_BUCKET`); uses the AWS keys. |
| `BACKUP_S3_PREFIX` | backups | no | `database-backups` | Folder in the bucket. |
| `BACKUP_ENCRYPTION_KEY` | backups | strongly recommended | 32+ random characters | Encrypts every backup. Keep a copy off the server. |

No secret is ever returned by the API, shown in the portal, written to a
log or put in a backup's metadata.

## Setting it up

1. **Migrate.** The API applies migrations at startup (`AUTO_MIGRATE=true`).
   Revision `c4e6a8b0d2f1` adds the tables; it only adds, and can be run
   again safely.
2. **Email.** Nothing new: the account in Settings → Email is used. The
   website's logo is attached to every email automatically.
3. **SMS (Twilio).** Set the Twilio variables and `PUBLIC_API_URL`, restart,
   then in Admin → Notifications switch SMS on and choose its events. Send a
   test from Templates. A local `PUBLIC_API_URL` (`localhost`, a private
   address) sends no status callback — Twilio rejects the whole message when
   the callback can't be reached — so messages show as "sent", not
   "delivered", until the API has a public address.
4. **WhatsApp (Twilio, including the Sandbox).** Set
   `NOTIFICATION_WHATSAPP_PROVIDER=twilio` and `NOTIFICATION_WHATSAPP_SENDER`
   (the sandbox number is `+14155238886`), switch WhatsApp on in Admin →
   Notifications, and have the customer opt in to WhatsApp in their account.
   An event with a Content template (`HX…`) on the Templates tab uses it; one
   without goes as plain text (its SMS wording). WhatsApp delivers plain text
   only within 24 hours of the customer's last message to the sender — in the
   Sandbox, after they've sent the `join …` code.
5. **WhatsApp (Meta).** Create and get approval for message templates in
   WhatsApp Manager (e.g. `order_update` with `{{1}}` name, `{{2}}` order
   number). Set the Meta variables and point the webhook at the URL above.
   In Admin → Notifications → Templates enter each event's template name and
   its variables in order; switch WhatsApp on and choose events.
6. **Campaigns.** Nothing to configure; customers opt in from their account
   or at sign-up. Set `PUBLIC_API_URL` to measure email opens.
7. **Backups.** Set `BACKUP_ENCRYPTION_KEY` (and S3 settings if wanted).
   Check Admin → Settings → Backups, press **Back up now** once, download it
   and run `python -m app.tools.backup verify` on it to see the whole cycle.
8. **Permissions.** New areas: `notifications`, `campaigns`, `backups`.
   Admins get notifications and campaigns; managers get campaigns; backups
   are the super admin's unless granted.

### Operational notes

- Background jobs (System health lists them): notifications every 30 s
  (sending, retries, membership reminders), campaigns every 60 s, backups
  checked every 5 min.
- Several API processes are fine: deliveries are claimed with
  `SELECT … FOR UPDATE SKIP LOCKED`, campaigns likewise, backups with a MySQL
  named lock.
- Delivery is *at least once* for a message interrupted mid-send by a crash
  (the row is retried after 10 minutes); providers offer no way to make that
  exactly once.
- Logs never contain passwords, API keys, tokens, backup contents or full
  message bodies; recipients are masked in the portal's lists.

## Tests

```bash
cd backend
.venv/Scripts/python -m pytest -p no:cacheprovider -q tests            # everything
.venv/Scripts/python -m pytest -q tests/integration/test_reorder.py \
    tests/integration/test_campaigns.py tests/integration/test_notification_channels.py \
    tests/integration/test_backups.py
```

The SMS/WhatsApp tests use a recording provider (`tests/integration/messaging_helpers.py`)
— never a real network call. Backup tests write to a temporary folder.

The frontend has no unit-test framework; check it with
`node node_modules/typescript/bin/tsc --noEmit -p .`, `npx eslint src` and
`npm run build`, and in the browser.
