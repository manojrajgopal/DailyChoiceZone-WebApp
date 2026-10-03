# Partial refunds

Refund chosen items, chosen quantities, the delivery fee and an optional extra
amount from an order. The server works out every figure.

- Backend: `app/services/refunds.py` decides *what* to refund: the
  calculation, approval, retries, the customer's view and the settings. The
  money itself moves in `app/services/invoices.py`, the one path every refund
  goes through: from the portal, from a return, or from a cancellation.
  Routes are in `app/api/routes/refunds.py`.
- Portal: `frontend/src/components/admin/views/refunds/`:
  - `OrderRefundsCard`
  - `RefundWizard`
  - `RefundSettingsPanel`

  The service is `services/admin/refundsAdminService.ts`.
- Storefront: `components/account/OrderRefunds.tsx`, on the customer's order
  page, using `services/refundHistoryService.ts`.

## Money

- **Units.** All amounts are integer paise, except `approvalThreshold` in the
  settings, which is whole rupees.
- **No figures from the browser.** The portal never adds anything up and never
  sends a refund amount. It sends lines and quantities, an optional shipping
  amount and an optional extra amount. Rupees typed in the wizard are
  converted to paise by parsing the string (`rupeesToPaise`), never through a
  float.
- **Shares of a line.** A line's shares are cumulative: the first `n` of `Q`
  units are worth `total × n ÷ Q`, rounded down. So any number of partial
  refunds of a line adds up to the line exactly, with the last unit taking the
  remainder. This applies to the discount and the tax (CGST, SGST, IGST) too.
- **Limits.** The server enforces these on every calculation, and again when
  the refund is raised:
  - No line beyond its units still refundable (ordered − cancelled −
    refunded): `QUANTITY_EXCEEDS_REFUNDABLE`.
  - No more delivery than was charged and not yet refunded:
    `SHIPPING_EXCEEDS_REFUNDABLE`.
  - No total beyond what is left on the order, counting refunds still waiting
    as well as completed ones: `REFUND_EXCEEDS_PAYMENT`.
- **Split.** On an order paid partly with a gift card, store credit or points,
  the refund splits between the payment and those, in the proportion they
  paid.

## Raising a refund (portal)

On the order page, the **Refunds** card shows:

- what's left to refund
- every refund, with its items, method, reason and status

**Refund items** opens the wizard:

1. Choose units per line, or click **Refund everything left**. The wizard
   suggests refunding delivery too when every item is being refunded.
2. Optionally add delivery and an extra amount.
3. Choose where the money goes (original payment method or store credit), and
   a reason. Optionally add a note for the customer and an internal note. For
   COD orders refunded to the original method, add the bank or UPI transfer
   reference.
4. The summary shows the server's breakdown: items, delivery, extra amount,
   tax and total. It's recalculated 300 ms after each change.
5. Submit. It sends an `idempotencyKey`, made once per opening of the wizard,
   so a double click or a retry after a dropped connection can't refund twice.

### Approval

- A refund above the approval threshold, raised by someone without
  `refunds-large`, is recorded as *requested* and waits.
- Someone with that permission approves it, which sends it, or rejects it with
  a note.
- A *failed* refund can be retried. A *processing* one can be checked with the
  gateway.
- Requested and failed refunds can be cancelled with a note.

No refund record is ever deleted.

## Customer view

The customer's order page lists that order's refunds. Each shows:

- amount and items
- delivery, if refunded
- where the money goes
- status: Requested, In progress or Refunded
- requested and refunded dates

Nothing internal is sent: no notes, gateway references, failure reasons or
staff names. To the customer, a failed attempt still reads as "In progress",
because retrying it is the store's job.

## Settings (`/api/admin/refunds/settings`; saving needs `refunds-large`)

| Setting | Default |
| --- | --- |
| `allowedMethods` | original, store credit |
| `approvalThreshold` (₹, 0 = none) | 10000 |
| `returnsSkipApproval` | on |
| `returnsMethod` | original |
| `codMethod` | store credit |
| `includeShippingOnFullRefund` (suggests refunding delivery) | on |
| `autoCreditNote` | off |
| `pollMinutes` (5–1440) | 30 |
| `maxAttempts` (1–10) | 3 |

Every save is audited (`refunds.settings.updated`). In the portal they are
under Billing settings → Refunds → **Item refunds**.

## Known gap

The invoice and payment detail pages still open the older whole-amount dialog
(`CreateRefundDialog`, `POST /admin/billing/refunds`). The server still caps
that amount. Moving those pages to the wizard is a follow-up.
