"""
Every customer email also lands in the bell; secrets never do; preferences
apply; staff see what needs them in the admin tray.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.core import rate_limit
from app.models import CustomerNotification, Notification

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def bell(db, customer_id="CUS001"):
    db.expire_all()
    return db.execute(select(CustomerNotification).where(CustomerNotification.customer_id == customer_id)
                      .order_by(CustomerNotification.id)).scalars().all()


def test_a_back_in_stock_alert_reaches_the_bell_without_an_email_account(client, db, auth, admin_auth, catalogue):
    client.post("/api/alerts/stock", headers=auth, json={"productId": "PRD003"})
    client.put("/api/admin/inventory/PRD003", headers=admin_auth, json={"quantity": 4, "reason": "restock"})
    rows = [r for r in bell(db) if r.kind == "product_alerts"]
    assert len(rows) == 1 and "Wireless Earbuds" in rows[0].title and rows[0].href.startswith("/product/")
    # The listing endpoint serves it.
    items = client.get("/api/support/notifications", headers=auth).json()["data"]
    assert any(i["kind"] == "product_alerts" for i in items)


def test_order_updates_and_points_reach_the_bell(client, db, auth, admin_auth, catalogue, settings_documents):
    from tests.integration.wallet_helpers import fill_bag, place

    fill_bag(client, auth)
    placed = place(client, auth)
    order_id = placed["order"]["id"]
    for status in ("processing", "packed", "shipped", "in-transit", "out-for-delivery", "delivered"):
        client.put(f"/api/admin/orders/{order_id}/status", headers=admin_auth, json={"status": status})
    kinds = [r.kind for r in bell(db)]
    assert "order_confirmation" in kinds and "order_updates" in kinds and "loyalty" in kinds
    order_rows = [r for r in bell(db) if r.kind == "order_updates"]
    assert all(r.href.startswith("/account/order?number=") for r in order_rows)


def test_store_credit_and_points_changes_by_staff(client, db, auth, admin_auth, customer):
    client.post("/api/admin/store-credit/CUS001", headers=admin_auth,
                json={"kind": "goodwill", "amount": 100, "reason": "Sorry for the delay"})
    client.post("/api/admin/loyalty/customers/CUS001/adjust", headers=admin_auth,
                json={"kind": "manual_credit", "points": 200, "reason": "Birthday bonus"})
    kinds = [r.kind for r in bell(db)]
    assert "store_credit" in kinds and "loyalty" in kinds


def test_secrets_never_reach_the_bell(client, db, customer):
    # A password reset email carries a one-time link: it stays out.
    client.post("/api/auth/password/forgot", json={"email": customer.email})
    assert not [r for r in bell(db) if r.kind == "account_security"]
    # A bag reminder link loses its recovery token.
    from app.services.inbox import _storefront_path
    from app.core.config import settings

    assert _storefront_path(f"Back to your bag: {settings.STOREFRONT_URL}/cart?recover=abc123") == "/cart"


def test_preferences_apply_to_the_bell(client, db, auth, admin_auth, catalogue):
    client.put("/api/account/email-preferences", headers=auth, json={"product_alerts": False})
    client.post("/api/alerts/stock", headers=auth, json={"productId": "PRD003"})
    client.put("/api/admin/inventory/PRD003", headers=admin_auth, json={"quantity": 4, "reason": "restock"})
    assert not [r for r in bell(db) if r.kind == "product_alerts"]


def test_the_same_news_twice_is_shown_once(db, customer):
    from app.services import inbox

    for _ in range(3):
        inbox.customer(db, "CUS001", "product_alerts", "Back in stock", "x", "/product/PRD003")
    db.flush()
    assert len(bell(db)) == 1


def test_a_gift_card_for_a_customer_appears_in_their_account_without_the_code(client, db, admin_auth, customer):
    response = client.post("/api/admin/gift-cards", headers=admin_auth, json={
        "amount": 500, "recipientName": "Asha", "recipientEmail": customer.email, "reason": "Contest prize"})
    assert response.status_code == 201
    rows = [r for r in bell(db) if r.kind == "gift_cards"]
    assert rows and rows[0].href == "/account/wallet" and "DCZG-" not in rows[0].body


def test_staff_see_new_questions_and_returns_in_the_tray(client, db, auth, catalogue):
    client.post("/api/products/cotton-kurta/questions", headers=auth,
                json={"question": "Does this kurta shrink after washing?"})
    tray = db.execute(select(Notification).where(Notification.kind == "question")).scalars().all()
    assert len(tray) == 1 and tray[0].admin_id is None and "Cotton Kurta" in tray[0].title


def test_staff_alerts_are_emailed_to_administrators_who_handle_them(client, db, auth, admin, editor, catalogue,
                                                                     monkeypatch):
    from app.services import email as email_service

    sent = []

    def record(db, key, *, to, customer_id, subject, html, text, reference="", inbox=None):
        sent.append({"key": key, "to": to, "subject": subject})
        return True

    monkeypatch.setattr(email_service, "notify", record)
    client.post("/api/products/cotton-kurta/questions", headers=auth,
                json={"question": "Does this kurta shrink after washing?"})
    staff_mail = [m for m in sent if m["key"] == "store_team"]
    # The super admin, and the editor (whose role moderates questions).
    assert {m["to"] for m in staff_mail} == {admin.email, editor.email}
    assert "Cotton Kurta" in staff_mail[0]["subject"]


def test_staff_alerts_go_only_to_roles_that_handle_them(client, db, admin, editor, monkeypatch):
    from app.services import email as email_service, inbox

    sent = []
    monkeypatch.setattr(email_service, "notify",
                        lambda db, key, *, to, **kw: sent.append(to) or True)
    inbox.staff(db, "webhook", "Payment webhook failed", "boom", "/admin/payments/webhooks", permission="payments")
    assert sent == [admin.email]
