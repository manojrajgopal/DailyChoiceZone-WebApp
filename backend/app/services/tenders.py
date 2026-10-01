"""
Paying for an order with gift cards, store credit and reward points.

## At checkout

`plan` works out, from the order's grand total, what each tender pays:
points first (within the store's limits), then gift cards in the order they
were entered, then store credit — each paying at most what is still owed. What
is left is `due`, which the gateway (or the courier, for cash on delivery)
collects. `apply` then spends them, inside the order's own transaction and
under row locks on each card and account, so two checkouts can't spend the
same balance and a failed checkout spends nothing.

The gateway can't take less than ₹1, so a remainder of a few paise is pushed
back onto the last tender rather than sent to the gateway.

## Going back

- **Cancelled** (by anyone, or a payment window closing): everything a tender
  paid goes back to it in full — `release_for_order`.
- **Refunded** (a return, or a refund raised in the portal): the refund is
  shared between the gateway and the tenders in the proportion they paid —
  `split_refund` decides, `reverse_for_refund` gives the tenders their share
  when the refund completes. A gift card that can no longer be used takes its
  share as store credit.

Each tender row remembers what has gone back, and every movement carries an
idempotency key, so nothing goes back twice however often it is retried.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, ValidationError
from app.models import Customer, Invoice, Order, OrderTender, Payment, Refund
from app.services import billing, gift_cards, loyalty, store_credit

logger = logging.getLogger(__name__)

GATEWAY_MINIMUM = 100  # paise


@dataclass
class CardUse:
    code_last4: str
    card_id: Optional[int]
    applied: int = 0
    balance: int = 0
    error: str = ""


@dataclass
class Plan:
    grand_total: int
    cards: List[CardUse] = field(default_factory=list)
    store_credit: int = 0
    store_credit_available: int = 0
    points: int = 0
    points_value: int = 0
    points_limits: dict = field(default_factory=dict)
    messages: List[str] = field(default_factory=list)

    @property
    def gift_card_total(self) -> int:
        return sum(card.applied for card in self.cards)

    @property
    def tender_total(self) -> int:
        return self.gift_card_total + self.store_credit + self.points_value

    @property
    def due(self) -> int:
        return max(0, self.grand_total - self.tender_total)

    def view(self) -> dict:
        return {
            "grandTotal": self.grand_total,
            "giftCards": [{"last4": c.code_last4, "applied": c.applied, "balance": c.balance, "error": c.error}
                          for c in self.cards],
            "giftCardTotal": self.gift_card_total,
            "storeCredit": {"available": self.store_credit_available, "applied": self.store_credit},
            "points": {**self.points_limits, "applied": self.points, "value": self.points_value},
            "tenderTotal": self.tender_total,
            "amountDue": self.due,
            "messages": self.messages,
        }


def plan(db: Session, customer: Customer, *, grand_total: int, coupon_applied: bool, gift_card_codes=(),
         use_store_credit: bool = False, points: int = 0, strict: bool = False, lock: bool = False) -> Plan:
    """
    What the tenders would pay. With `strict` (placing the order) anything the
    customer asked for that can't be honoured is an error, rather than quietly
    paid for some other way; with `lock` the cards and accounts are locked.
    """
    conf = gift_cards.settings(db)
    result = Plan(grand_total=grand_total)
    codes = [c for c in dict.fromkeys(str(code).strip() for code in (gift_card_codes or [])) if c]
    if len(codes) > int(conf["maxCardsPerOrder"]):
        raise ValidationError(f"Use up to {conf['maxCardsPerOrder']} gift cards on one order.", error_code="TOO_MANY_GIFT_CARDS")
    if codes and coupon_applied and not conf["allowWithCoupons"]:
        raise ValidationError("Gift cards can't be used together with a coupon.", error_code="GIFT_CARD_WITH_COUPON")
    if use_store_credit and not conf["storeCreditEnabled"]:
        raise ValidationError("Store credit isn't available right now.", error_code="STORE_CREDIT_OFF")
    if use_store_credit and codes and not conf["storeCreditWithGiftCards"]:
        raise ValidationError("Store credit can't be combined with a gift card.", error_code="STORE_CREDIT_WITH_GIFT_CARD")
    if use_store_credit and coupon_applied and not conf["storeCreditWithCoupons"]:
        raise ValidationError("Store credit can't be combined with a coupon.", error_code="STORE_CREDIT_WITH_COUPON")

    owed = grand_total

    # --- points
    limits = loyalty.redemption_limits(db, customer.id, grand_total, coupon=coupon_applied,
                                       gift_cards=bool(codes), store_credit=use_store_credit)
    result.points_limits = limits
    requested = max(0, int(points or 0))
    if requested:
        lconf = loyalty.settings(db)
        if not limits["maxPoints"]:
            if strict:
                raise ConflictError(limits["reason"] or "Points can't be used on this order.", error_code="POINTS_NOT_ALLOWED")
            result.messages.append(limits["reason"])
        elif strict and requested > limits["maxPoints"]:
            raise ConflictError(f"You can use up to {limits['maxPoints']:,} points on this order.",
                                error_code="POINTS_OVER_LIMIT")
        elif strict and requested < limits["minRedeemPoints"]:
            raise ConflictError(f"Use at least {limits['minRedeemPoints']:,} points.", error_code="POINTS_UNDER_MINIMUM")
        else:
            use = max(min(requested, limits["maxPoints"]), 0)
            if use and use < limits["minRedeemPoints"]:
                use = 0
                result.messages.append(f"Use at least {limits['minRedeemPoints']:,} points.")
            # Never spend points worth more than is owed.
            use = min(use, loyalty.points_for(lconf, owed))
            if use and use < limits["minRedeemPoints"]:
                use = 0
            result.points, result.points_value = use, loyalty.value_of(lconf, use) if use else 0
            owed -= result.points_value

    # --- gift cards
    now = datetime.utcnow()
    for code in codes:
        card = gift_cards.find(db, code, lock=lock)
        last4 = gift_cards.normalise(code)[-4:] if card is None else card.code_last4
        reason = gift_cards.usable_reason(card, now)
        if reason:
            if strict:
                raise ConflictError(f"Gift card ending {last4}: {reason}", error_code="GIFT_CARD_UNUSABLE")
            result.cards.append(CardUse(code_last4=last4, card_id=card.id if card else None, error=reason))
            continue
        if any(c.card_id == card.id for c in result.cards):
            continue
        applied = min(card.balance, owed)
        result.cards.append(CardUse(code_last4=card.code_last4, card_id=card.id, applied=applied, balance=card.balance))
        owed -= applied

    # --- store credit
    if use_store_credit:
        row = store_credit.account(db, customer.id, lock=lock) if lock else None
        available = row.balance if row is not None else store_credit.balance(db, customer.id)
        result.store_credit_available = available
        result.store_credit = min(available, owed)
        owed -= result.store_credit
        if strict and available <= 0:
            raise ConflictError("You don't have store credit to use.", error_code="NO_STORE_CREDIT")
    else:
        result.store_credit_available = store_credit.balance(db, customer.id)

    _respect_gateway_minimum(db, result)
    return result


def _respect_gateway_minimum(db: Session, result: Plan) -> None:
    """A gateway can't collect less than ₹1: give a few paise back to the last tender instead."""
    due = result.due
    if not 0 < due < GATEWAY_MINIMUM or not result.tender_total:
        return
    short = GATEWAY_MINIMUM - due
    if result.store_credit:
        back = min(short, result.store_credit)
        result.store_credit -= back
        short -= back
    for card in reversed(result.cards):
        if short <= 0:
            break
        back = min(short, card.applied)
        card.applied -= back
        short -= back
    if short > 0 and result.points:
        conf = loyalty.settings(db)
        while short > 0 and result.points:
            before = result.points_value
            result.points -= 1
            result.points_value = loyalty.value_of(conf, result.points)
            short -= before - result.points_value
    result.messages.append("A small amount is left for your payment method — online payments start at ₹1.")


def apply(db: Session, order: Order, invoice: Invoice, result: Plan) -> None:
    """
    Spend the planned tenders for `order` and record them on the order and
    invoice. Inside the order's transaction; never commits. The cards and
    accounts must have been locked by `plan(..., lock=True)`.
    """
    now = datetime.utcnow()
    if result.points:
        value = loyalty.redeem(db, order.customer_id, result.points, order_id=order.id)
        if value != result.points_value:
            raise ConflictError("The value of your points changed. Please try again.", error_code="POINTS_VALUE_CHANGED")
        db.add(OrderTender(order_id=order.id, kind="points", tender_key="points", amount=result.points_value,
                           points=result.points, reversed_amount=0, reversed_points=0, created_at=now, updated_at=now))
    for use in result.cards:
        if not use.applied:
            continue
        card = gift_cards.lock(db, use.card_id)
        gift_cards.redeem(db, card, use.applied, order_id=order.id)
        db.add(OrderTender(order_id=order.id, kind="gift_card", tender_key=f"gift_card:{card.id}", gift_card_id=card.id,
                           amount=use.applied, points=0, reversed_amount=0, reversed_points=0, created_at=now,
                           updated_at=now))
    if result.store_credit:
        try:
            store_credit.post(db, order.customer_id, kind="redeem", amount=-result.store_credit,
                              reason=f"Order {order.order_number}", order_id=order.id, idempotency_key=f"redeem:{order.id}")
        except store_credit.AlreadyPosted:
            raise ConflictError("Store credit was already used on this order.", error_code="STORE_CREDIT_USED") from None
        db.add(OrderTender(order_id=order.id, kind="store_credit", tender_key="store_credit",
                           amount=result.store_credit, points=0, reversed_amount=0, reversed_points=0,
                           created_at=now, updated_at=now))

    invoice.gift_card_amount = result.gift_card_total
    invoice.store_credit_amount = result.store_credit
    invoice.points_amount = result.points_value
    invoice.points_redeemed = result.points
    order.gift_card_amount = billing.to_major(result.gift_card_total)
    order.store_credit_amount = billing.to_major(result.store_credit)
    order.points_amount = billing.to_major(result.points_value)
    order.points_redeemed = result.points
    db.flush()


def tender_total(invoice: Optional[Invoice]) -> int:
    if invoice is None:
        return 0
    return int(invoice.gift_card_amount or 0) + int(invoice.store_credit_amount or 0) + int(invoice.points_amount or 0)


def tenders_for(db: Session, order_id: str, *, lock: bool = False) -> List[OrderTender]:
    query = select(OrderTender).where(OrderTender.order_id == order_id).order_by(OrderTender.id)
    if lock:
        query = query.with_for_update()
    return list(db.execute(query).scalars())


def _give_back(db: Session, order: Order, tender: OrderTender, amount: int, *, key: str,
               refund_id: Optional[str] = None, reason: str) -> None:
    """Return `amount` (paise) of what `tender` paid. Points tenders go back as points, in proportion."""
    if amount <= 0:
        return
    if tender.kind == "gift_card":
        gift_cards.restore(db, tender.gift_card_id, amount, order_id=order.id, key=key, refund_id=refund_id,
                           customer_id=order.customer_id)
    elif tender.kind == "store_credit":
        store_credit.credit_customer(db, order.customer_id, kind="refund" if refund_id else "restore", amount=amount,
                                     key=key, order_id=order.id, refund_id=refund_id, reason=reason,
                                     notify=bool(refund_id))
    elif tender.kind == "points":
        left_amount = tender.amount - tender.reversed_amount
        left_points = tender.points - tender.reversed_points
        points = left_points if amount >= left_amount else min(left_points, round(tender.points * amount / tender.amount))
        restored = loyalty.restore(db, order.id, points, key=key, refund_id=refund_id, reason=reason)
        tender.reversed_points += restored
    tender.reversed_amount += amount
    tender.updated_at = datetime.utcnow()


def release_for_order(db: Session, order: Order, *, reason: str = "Order cancelled") -> int:
    """An order that won't go ahead gives every tender back what is left of it. Never commits."""
    total = 0
    for tender in tenders_for(db, order.id, lock=True):
        left = tender.amount - tender.reversed_amount
        if left > 0:
            _give_back(db, order, tender, left, key=f"cancel:{order.id}:{tender.tender_key}", reason=reason)
            total += left
    return total


def unreversed(db: Session, order_id: str) -> int:
    return sum(t.amount - t.reversed_amount for t in tenders_for(db, order_id))


def split_refund(db: Session, invoice: Invoice, payment: Payment, amount: int) -> tuple:
    """
    Share a refund of `amount` between the gateway and the tenders, in the
    proportion they paid the invoice, within what each has left to give back.
    Returns (gateway_amount, tender_amount).
    """
    from app.services.invoices import refundable_amount

    tendered = tender_total(invoice)
    gateway_room = refundable_amount(payment)
    tender_room = unreversed(db, invoice.order_id) if tendered else 0
    if amount > gateway_room + tender_room:
        raise ConflictError("That is more than is left to refund on this order.", error_code="REFUND_EXCEEDS_PAYMENT")
    if not tendered:
        return amount, 0
    gateway_paid = max(0, invoice.grand_total - tendered)
    gateway_share = (amount * gateway_paid + invoice.grand_total // 2) // max(1, invoice.grand_total)
    gateway_share = min(gateway_share, gateway_room)
    tender_share = amount - gateway_share
    if tender_share > tender_room:
        gateway_share += tender_share - tender_room
        tender_share = tender_room
    return gateway_share, tender_share


def reverse_for_refund(db: Session, refund: Refund) -> None:
    """A completed refund's tender share goes back to the tenders, in proportion. Once per refund."""
    if not refund.tender_amount:
        return
    order = db.get(Order, refund.order_id)
    if order is None:
        return
    rows = [t for t in tenders_for(db, order.id, lock=True) if t.amount > t.reversed_amount]
    room = sum(t.amount - t.reversed_amount for t in rows)
    share = min(refund.tender_amount, room)
    if share <= 0:
        return
    # Largest remainder, so the parts add up exactly.
    parts = []
    for tender in rows:
        left = tender.amount - tender.reversed_amount
        exact = share * left
        parts.append([tender, exact // room, exact % room, left])
    leftover = share - sum(p[1] for p in parts)
    for part in sorted(parts, key=lambda p: -p[2]):
        if leftover <= 0:
            break
        if part[1] < part[3]:
            part[1] += 1
            leftover -= 1
    for tender, give, _, _ in parts:
        _give_back(db, order, tender, give, key=f"refund:{refund.id}:{tender.tender_key}", refund_id=refund.id,
                   reason=f"Refund {refund.refund_number}")


def describe(db: Session, order_id: str) -> List[dict]:
    """The tenders on an order, for its page and invoice. Gift cards by their last four only."""
    out = []
    for tender in tenders_for(db, order_id):
        label = {"points": "Reward points", "store_credit": "Store credit"}.get(tender.kind, "Gift card")
        if tender.kind == "gift_card" and tender.gift_card_id:
            from app.models import GiftCard

            card = db.get(GiftCard, tender.gift_card_id)
            label = f"Gift card ending {card.code_last4}" if card else label
        out.append({"kind": tender.kind, "label": label, "amount": tender.amount, "points": tender.points or None,
                    "returned": tender.reversed_amount})
    return out
