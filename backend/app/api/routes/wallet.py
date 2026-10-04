"""
Gift cards, store credit and reward points.

Customers:

    GET  /api/gift-cards/options                amounts and rules for buying one (public)
    POST /api/gift-cards/purchase               start buying a card for someone
    POST /api/gift-cards/{id}/verify            confirm its payment
    POST /api/gift-cards/{id}/abandon           close an unpaid purchase
    POST /api/gift-cards/check                  balance of a code you hold
    GET  /api/gift-cards/mine                   cards you bought

    GET  /api/account/store-credit              balance, and history (paged)
    GET  /api/account/rewards                   points summary and rules, and history (paged)
    POST /api/checkout/tenders                  what gift cards, credit and points would pay

Portal:

    /api/admin/gift-cards ...      list, detail, issue, disable/enable, new code, refund, settings
    /api/admin/store-credit ...    customers with credit, one customer's ledger, add/remove
    /api/admin/loyalty ...         dashboard, balances, ledger, adjust, settings, run housekeeping
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy.orm import Session

from app.core import rate_limit
from app.core.database import get_db
from app.dependencies.auth import client_ip, get_current_customer, require_access
from app.models import AdminUser, Customer, GiftCard
from app.schemas.base import CamelModel
from app.services import gift_cards, loyalty, store_credit, tenders
from app.utils.response import Pagination, ok

router = APIRouter(prefix="/gift-cards", tags=["Gift cards"])
account_router = APIRouter(prefix="/account", tags=["Account · Wallet"])
checkout_router = APIRouter(prefix="/checkout", tags=["Checkout"])
admin_gift_router = APIRouter(prefix="/admin/gift-cards", tags=["Admin · Gift cards"])
admin_credit_router = APIRouter(prefix="/admin/store-credit", tags=["Admin · Store credit"])
admin_loyalty_router = APIRouter(prefix="/admin/loyalty", tags=["Admin · Loyalty"])


def _page(page: int, size: int, total: int) -> dict:
    return Pagination.build(page, size, total).model_dump()


# -------------------------------------------------------------- gift cards


@router.get("/options", summary="What gift cards can be bought")
def options(db: Session = Depends(get_db)):
    conf = gift_cards.settings(db)
    return ok({k: conf[k] for k in ("enabled", "minAmount", "maxAmount", "denominations", "allowCustomAmount",
                                    "validityMonths")})


class PurchaseRequest(CamelModel):
    amount: float = Field(gt=0, le=1_000_000)
    recipient_name: str = Field(min_length=1, max_length=120)
    recipient_email: str = Field(min_length=3, max_length=255)
    sender_name: str = Field(default="", max_length=120)
    message: str = Field(default="", max_length=600)


@router.post("/purchase", status_code=201, summary="Buy a gift card")
def purchase(payload: PurchaseRequest, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    rate_limit.check(f"gc-buy:{customer.id}", limit=10, window_seconds=3600,
                     message="Please wait a little before buying more gift cards.")
    card, handoff = gift_cards.start_purchase(db, customer, amount=payload.amount, recipient_name=payload.recipient_name,
                                              recipient_email=payload.recipient_email, sender_name=payload.sender_name,
                                              message=payload.message)
    return ok({"giftCard": gift_cards.owner_view(card), "gateway": handoff or None},
              message="Gift card sent." if card.status == "active" else "Complete the payment to send your gift card.")


class VerifyRequest(CamelModel):
    """What Razorpay Checkout hands the browser — the same shape as a membership's."""

    razorpay_payment_id: str = Field(default="", max_length=64)
    razorpay_order_id: str = Field(default="", max_length=64)
    razorpay_signature: str = Field(default="", max_length=128)


@router.post("/{card_id}/verify", summary="Confirm a gift card payment")
def verify(card_id: int, payload: VerifyRequest, db: Session = Depends(get_db),
           customer: Customer = Depends(get_current_customer)):
    card = gift_cards.confirm_purchase(db, customer, card_id, payload.model_dump(by_alias=False))
    return ok(gift_cards.owner_view(card), message="Gift card sent.")


@router.post("/{card_id}/abandon", summary="Close an unpaid gift card purchase")
def abandon(card_id: int, db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    gift_cards.cancel_pending(db, customer, card_id)
    return ok(message="Purchase closed.")


class CodeRequest(CamelModel):
    code: str = Field(min_length=1, max_length=40)


@router.post("/check", summary="Check a gift card's balance")
def check(payload: CodeRequest, request: Request, db: Session = Depends(get_db),
          customer: Customer = Depends(get_current_customer)):
    # Tight, per account and per address: a code is a bearer secret, and this
    # is the endpoint someone guessing codes would use.
    too_many = "Too many gift card checks. Please wait a few minutes."
    rate_limit.check(f"gc-check:{customer.id}", limit=10, window_seconds=600, message=too_many)
    rate_limit.check(f"gc-check-ip:{client_ip(request)}", limit=20, window_seconds=600, message=too_many)
    card = gift_cards.find(db, payload.code)
    reason = gift_cards.usable_reason(card)
    if card is None:
        return ok({"valid": False, "reason": reason})
    return ok({"valid": True, "reason": reason, **gift_cards.public_view(card)})


@router.get("/mine", summary="Gift cards you bought")
def mine(db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    return ok(gift_cards.mine(db, customer))


# ------------------------------------------------------- account: wallet


@account_router.get("/store-credit", summary="Your store credit")
def my_store_credit(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100, alias="pageSize"),
                    db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    rows, total = store_credit.history(db, customer.id, page=page, page_size=page_size)
    return ok({**store_credit.summary(db, customer.id), "items": [store_credit.view(r) for r in rows],
               "pagination": _page(page, page_size, total)})


@account_router.get("/rewards", summary="Your reward points")
def my_rewards(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100, alias="pageSize"),
               db: Session = Depends(get_db), customer: Customer = Depends(get_current_customer)):
    items, total = loyalty.history(db, customer.id, page=page, page_size=page_size)
    return ok({**loyalty.summary(db, customer.id), "items": items, "pagination": _page(page, page_size, total)})


# ------------------------------------------------------------- checkout


class TenderPreviewRequest(CamelModel):
    coupon_code: Optional[str] = Field(default=None, max_length=40)
    delivery_method: str = Field(default="standard", max_length=20)
    place_of_supply: Optional[str] = Field(default=None, max_length=120)
    pincode: Optional[str] = Field(default=None, max_length=10)
    gift_card_codes: List[str] = Field(default_factory=list, max_length=5)
    use_store_credit: bool = False
    points: int = Field(default=0, ge=0, le=10_000_000)


@checkout_router.post("/tenders", summary="What gift cards, store credit and points would pay")
def preview(payload: TenderPreviewRequest, db: Session = Depends(get_db),
            customer: Customer = Depends(get_current_customer)):
    if payload.gift_card_codes:
        rate_limit.check(f"gc-preview:{customer.id}", limit=30, window_seconds=600,
                         message="Too many gift card checks. Please wait a few minutes.")
    from app.services import cart as cart_service

    cart = cart_service.get_cart(db, customer, coupon_code=payload.coupon_code, delivery_method=payload.delivery_method,
                                 place_of_supply=payload.place_of_supply, pincode=payload.pincode)
    breakdown = cart["breakdown"]
    result = tenders.plan(db, customer, grand_total=breakdown["grandTotal"],
                          coupon_applied=bool(breakdown.get("couponCode")),
                          gift_card_codes=[c[:40] for c in payload.gift_card_codes],
                          use_store_credit=payload.use_store_credit, points=payload.points)
    return ok(result.view())


# --------------------------------------------------------- admin: cards


@admin_gift_router.get("", summary="Gift cards")
def admin_list_cards(status: str = Query("", max_length=20), q: str = Query("", max_length=80),
                     customer: str = Query("", max_length=40), code: str = Query("", max_length=40),
                     page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                     db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("gift-cards"))):
    """`q` is a Gift card ID, `customer` the purchaser's Customer ID, `code` a whole card code — all exact."""
    items, total, counts, outstanding = gift_cards.admin_search(db, status=status, q=q, customer=customer, code=code,
                                                                page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "counts": counts,
               "outstanding": outstanding})


@admin_gift_router.get("/settings", summary="Gift card and store credit settings")
def admin_card_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("gift-cards"))):
    return ok(gift_cards.settings(db))


@admin_gift_router.put("/settings", summary="Save gift card and store credit settings")
def admin_save_card_settings(payload: dict, db: Session = Depends(get_db),
                             admin: AdminUser = Depends(require_access("gift-cards"))):
    return ok(gift_cards.save_settings(db, payload), message="Gift card settings saved.")


@admin_gift_router.get("/{card_id}", summary="One gift card and its history")
def admin_card(card_id: int, db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("gift-cards"))):
    card = db.get(GiftCard, card_id)
    if card is None:
        from app.core.errors import NotFoundError

        raise NotFoundError("No such gift card.", error_code="GIFT_CARD_NOT_FOUND")
    return ok(gift_cards.admin_view(db, card, detail=True))


class IssueRequest(CamelModel):
    amount: float = Field(gt=0, le=100000)
    recipient_name: str = Field(min_length=1, max_length=120)
    recipient_email: str = Field(min_length=3, max_length=255)
    message: str = Field(default="", max_length=600)
    reason: str = Field(min_length=1, max_length=300)


@admin_gift_router.post("", status_code=201, summary="Issue a gift card")
def admin_issue(payload: IssueRequest, db: Session = Depends(get_db),
                admin: AdminUser = Depends(require_access("gift-cards"))):
    rate_limit.check(f"gc-issue:{admin.id}", limit=30, window_seconds=600)
    card = gift_cards.admin_issue(db, admin, amount=payload.amount, recipient_name=payload.recipient_name,
                                  recipient_email=payload.recipient_email, message=payload.message,
                                  reason=payload.reason)
    from app.services import email as email_service

    if card.delivered_at:
        message = f"Gift card issued and emailed to {card.recipient_email}."
    elif email_service.active_account(db) is None:
        message = "Gift card issued, but it couldn't be emailed: no email account is connected. Connect one, then use “Email a new code”."
    else:
        message = "Gift card issued, but the email couldn't be sent. Check Email history, then use “Email a new code”."
    return ok(gift_cards.admin_view(db, card, detail=True), message=message)


class ReasonRequest(CamelModel):
    reason: str = Field(min_length=1, max_length=300)


@admin_gift_router.post("/{card_id}/disable", summary="Disable a gift card")
def admin_disable(card_id: int, payload: ReasonRequest, db: Session = Depends(get_db),
                  admin: AdminUser = Depends(require_access("gift-cards"))):
    card = gift_cards.admin_set_status(db, admin, card_id, action="disable", reason=payload.reason)
    return ok(gift_cards.admin_view(db, card, detail=True), message="Gift card disabled.")


@admin_gift_router.post("/{card_id}/enable", summary="Re-enable a gift card")
def admin_enable(card_id: int, payload: ReasonRequest, db: Session = Depends(get_db),
                 admin: AdminUser = Depends(require_access("gift-cards"))):
    card = gift_cards.admin_set_status(db, admin, card_id, action="enable", reason=payload.reason)
    return ok(gift_cards.admin_view(db, card, detail=True), message="Gift card re-enabled.")


@admin_gift_router.post("/{card_id}/reissue", summary="Send a new code")
def admin_reissue(card_id: int, payload: ReasonRequest, db: Session = Depends(get_db),
                  admin: AdminUser = Depends(require_access("gift-cards"))):
    card = gift_cards.admin_reissue(db, admin, card_id, reason=payload.reason)
    from app.services import email as email_service

    message = ("New code emailed; the old one no longer works." if email_service.active_account(db) is not None
               else "New code made, but it couldn't be emailed: no email account is connected.")
    return ok(gift_cards.admin_view(db, card, detail=True), message=message)


@admin_gift_router.post("/{card_id}/refund", summary="Refund an unused purchased card")
def admin_refund(card_id: int, payload: ReasonRequest, db: Session = Depends(get_db),
                 admin: AdminUser = Depends(require_access("gift-cards"))):
    card = gift_cards.admin_refund_unused(db, admin, card_id, reason=payload.reason)
    return ok(gift_cards.admin_view(db, card, detail=True), message="Refunded to the purchaser.")


# --------------------------------------------------------- admin: credit


@admin_credit_router.get("", summary="Customers' store credit")
def admin_credit_list(q: str = Query("", max_length=80), with_balance: bool = Query(False, alias="withBalance"),
                      page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                      db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("store-credit"))):
    items, total, outstanding = store_credit.admin_search(db, q=q, only_with_balance=with_balance, page=page,
                                                          page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total), "outstanding": outstanding})


@admin_credit_router.get("/{customer_id}", summary="One customer's store credit ledger")
def admin_credit_customer(customer_id: str, page: int = Query(1, ge=1),
                          page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                          db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("store-credit"))):
    customer = db.get(Customer, customer_id[:20])
    if customer is None:
        from app.core.errors import NotFoundError

        raise NotFoundError("No such customer.", error_code="CUSTOMER_NOT_FOUND")
    rows, total = store_credit.history(db, customer.id, page=page, page_size=page_size)
    items = []
    for row in rows:
        view = store_credit.view(row)
        view["by"] = row.admin_name or None
        items.append(view)
    return ok({"customer": {"id": customer.id, "name": customer.full_name, "email": customer.email},
               **store_credit.summary(db, customer.id), "items": items, "pagination": _page(page, page_size, total)})


class CreditAdjustRequest(CamelModel):
    kind: str = Field(pattern="^(grant|goodwill|promotion|revoke)$")
    amount: float = Field(gt=0, le=100000)
    reason: str = Field(min_length=1, max_length=300)
    request_key: str = Field(default="", max_length=40)


@admin_credit_router.post("/{customer_id}", status_code=201, summary="Add or remove store credit")
def admin_credit_adjust(customer_id: str, payload: CreditAdjustRequest, db: Session = Depends(get_db),
                        admin: AdminUser = Depends(require_access("store-credit"))):
    entry = store_credit.admin_adjust(db, admin, customer_id[:20], kind=payload.kind, amount=payload.amount,
                                      reason=payload.reason, request_key=payload.request_key)
    return ok(store_credit.view(entry), message="Store credit updated.")


# -------------------------------------------------------- admin: loyalty


@admin_loyalty_router.get("/metrics", summary="Reward points at a glance")
def admin_loyalty_metrics(days: int = Query(30, ge=1, le=365), db: Session = Depends(get_db),
                          admin: AdminUser = Depends(require_access("loyalty"))):
    return ok(loyalty.admin_metrics(db, days=days))


@admin_loyalty_router.get("/balances", summary="Customers' points")
def admin_loyalty_balances(q: str = Query("", max_length=80), page: int = Query(1, ge=1),
                           page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                           db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("loyalty"))):
    items, total = loyalty.admin_balances(db, q=q, page=page, page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total)})


@admin_loyalty_router.get("/ledger", summary="Every points movement")
def admin_loyalty_ledger(kind: str = Query("", max_length=20), q: str = Query("", max_length=80),
                         customer_id: str = Query("", max_length=40, alias="customerId",
                                                  description="A Customer ID, exactly."),
                         order_id: str = Query("", max_length=40, alias="orderId",
                                               description="An Order ID or order number, exactly."),
                         page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=100, alias="pageSize"),
                         db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("loyalty"))):
    items, total = loyalty.admin_ledger(db, kind=kind, q=q, customer_id=customer_id, order_id=order_id, page=page,
                                        page_size=page_size)
    return ok({"items": items, "pagination": _page(page, page_size, total)})


@admin_loyalty_router.get("/settings", summary="Reward points rules")
def admin_loyalty_settings(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("loyalty"))):
    return ok(loyalty.settings(db))


@admin_loyalty_router.put("/settings", summary="Save reward points rules")
def admin_loyalty_save(payload: dict, db: Session = Depends(get_db),
                       admin: AdminUser = Depends(require_access("loyalty"))):
    return ok(loyalty.save_settings(db, payload), message="Reward points rules saved.")


class PointsAdjustRequest(CamelModel):
    kind: str = Field(pattern="^(manual_credit|manual_debit)$")
    points: int = Field(gt=0, le=1_000_000)
    reason: str = Field(min_length=1, max_length=300)
    request_key: str = Field(default="", max_length=40)


@admin_loyalty_router.post("/customers/{customer_id}/adjust", status_code=201, summary="Add or remove points")
def admin_loyalty_adjust(customer_id: str, payload: PointsAdjustRequest, db: Session = Depends(get_db),
                         admin: AdminUser = Depends(require_access("loyalty"))):
    entry = loyalty.admin_adjust(db, admin, customer_id[:20], kind=payload.kind, points=payload.points,
                                 reason=payload.reason, request_key=payload.request_key)
    return ok(loyalty.txn_view(entry), message="Points updated.")


@admin_loyalty_router.get("/customers/{customer_id}", summary="One customer's points")
def admin_loyalty_customer(customer_id: str, db: Session = Depends(get_db),
                           admin: AdminUser = Depends(require_access("loyalty"))):
    customer = db.get(Customer, customer_id[:20])
    if customer is None:
        from app.core.errors import NotFoundError

        raise NotFoundError("No such customer.", error_code="CUSTOMER_NOT_FOUND")
    return ok({"customer": {"id": customer.id, "name": customer.full_name, "email": customer.email},
               **loyalty.summary(db, customer.id)})


@admin_loyalty_router.post("/housekeeping", summary="Release pending points and expire old ones now")
def admin_loyalty_run(db: Session = Depends(get_db), admin: AdminUser = Depends(require_access("loyalty"))):
    rate_limit.check(f"loyalty-run:{admin.id}", limit=5, window_seconds=300)
    released = loyalty.release_due(db)
    expired = loyalty.expire_due(db)
    return ok({"released": released, "expiredPoints": expired},
              message=f"Released {released} pending batches; expired {expired:,} points.")
