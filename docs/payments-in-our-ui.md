# Payments in our own interface

Every payment is taken on the store's own pages: checkout, finishing an unpaid
order, paying a cash-on-delivery order online, memberships and gift cards.
Razorpay's modal (Standard Checkout) and Razorpay-hosted Payment Link pages are
not used anywhere.

## How it works

The browser uses **Razorpay Custom Checkout** (`razorpay.js`), which renders
nothing. The store draws every option itself (`components/checkout/PaymentMethods`)
and hands the shopper's choice to `createPayment`:

| Method | What the shopper sees |
|---|---|
| UPI (phone) | Our app buttons → their own UPI app opens to approve |
| UPI (desktop) | Our QR code panel (the server's single-use QR for orders; Custom Checkout's QR for memberships and gift cards) |
| Card | **Our card form** (`components/checkout/CardForm`) → their bank's 3-D Secure page for the OTP |
| Net banking | Our bank list → their bank's sign-in page |
| Wallet | Our wallet list → the wallet's approval page |
| Cash on delivery | **Slide to place order** (`components/ui/SlideToConfirm`) |

What still appears that isn't ours: the shopper's **own UPI app**, their
**bank's** net-banking or 3-D Secure (OTP) page, and the **wallet's** page.
These are the authentication steps of the bank or app itself, which no merchant
can replace. While a bank page opens, Razorpay's popup may show a brief
"redirecting" screen.

The outcome is settled the same way as before: the three references go to our
server, which checks the signature with the key secret, reads the payment back
from Razorpay and compares the amount. The webhook settles it too.

## Cards in our form: what it requires

Taking card numbers in the store's own form was the store's decision
(2 October 2026). It has two consequences outside the code:

1. **Razorpay must enable it.** Razorpay accepts card payments through Custom
   Checkout only on accounts it has enabled for this, and asks for the
   merchant's PCI-DSS compliance first. Until then, Razorpay refuses card
   payments from our form, and the shopper sees Razorpay's reason. UPI, net
   banking and wallets work regardless. Ask Razorpay support to enable "card
   payments on Custom Checkout" for the account.
2. **PCI-DSS SAQ-D.** A page that collects card numbers in its own form puts the
   storefront in PCI-DSS scope (SAQ-D rather than SAQ-A). That means an annual
   self-assessment, quarterly ASV scans of the storefront, and controls over
   the frontend's deployment and its third-party scripts.

What the code does to keep the exposure as small as it can be:

- Card details live only in `CardForm`'s React state. On "Pay" they are
  validated (Luhn, length per brand, expiry, CVV length:
  `lib/payments/card.ts`), passed to `createPayment` and **cleared**.
  `startCustomPayment` deletes the `card[…]` fields from its request object
  right after the call.
- They are never sent to our API, written to a store, local or session
  storage, a cookie or the URL, logged, or put in an analytics event or error
  message. The UI never shows more than `•••• 4242`.
- The inputs use the standard `cc-*` autocomplete names, so browsers and
  password managers can fill saved cards, and the CVV field is `type="password"`.

## Paying a cash-on-delivery order online

This replaces Razorpay Payment Links.

- **The store:** Orders → an unpaid COD order → **Ask to pay online**
  (`POST /api/admin/orders/{id}/payment-link`, which keeps its old path). This
  sends the store's own email (event `payment_request`, and SMS/WhatsApp where
  switched on in Messaging) with a link to
  `/checkout/payment?payment=<id>&online=1`. It can be sent again.
- **The customer:** "Pay online now instead" on their order page, or the link.
  The page calls `POST /api/payments/{id}/online`, which opens one Razorpay
  order for exactly what is owed (or returns the one already opened, never a
  second one) and pays it in our interface. Paid, the order is marked paid and
  the courier collects nothing.

Payment Links already sent before this change still settle, through
`/api/payments/link-callback` and the `payment_link.paid` webhook. No new ones
are raised (`settlement.open_payment_link` is kept only for that).

### `POST /api/payments/{paymentId}/online`

Customer token, own payments only (404 otherwise). Rate-limited to 20 per 5
minutes per customer.

```json
{ "success": true, "data": { "status": "pending", "orderNumber": "DCZ10042",
  "gateway": { "provider": "razorpay", "keyId": "rzp_…", "orderReference": "order_…",
               "paymentId": "PAY042", "amount": 249800, "currency": "INR", "…": "…" } } }
```

| Error code | When |
|---|---|
| `ALREADY_PAID` (409) | The order is paid |
| `ORDER_NOT_PAYABLE` (409) | The order is cancelled, returned or delivered |
| `ORDER_IN_CHECKOUT` (409) | A COD order still in checkout |
| `PROVIDER_UNSUPPORTED` (409) | No live gateway configured |
| `GATEWAY_UNAVAILABLE` (409) | Razorpay couldn't open the order |

## Memberships and gift cards

Both now pay in `components/checkout/EmbeddedPayment` on their own pages, with
the same methods, card form and progress view as checkout. Cash on delivery
and the order-only QR codes are not offered. Each settles through its own
verify endpoint (`/memberships/{id}/verify`, `/gift-cards/{id}/verify`).
"Cancel — don't pay now" releases what was held, as closing Razorpay's window
used to.

## Removed

`frontend/src/services/payments/razorpayCheckout.ts` (Standard Checkout, the
modal) and its tests. Nothing loads `checkout.razorpay.com/v1/checkout.js` any
more.
