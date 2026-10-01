"""
Marketing campaigns: built as drafts, aimed with filters, sent only to
customers who opted in, tested before launch, launched once after confirming
the message count, and sent to each recipient once whatever restarts happen —
with analytics from what really happened.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.models import (
    CampaignRecipient,
    Customer,
    CustomerNotification,
    EmailLog,
    MarketingCampaign,
    NotificationDelivery,
)
from app.services.messaging import campaigns, providers, service as messaging
from tests.integration.messaging_helpers import email_account, sms_whatsapp  # noqa: F401
from tests.integration.wallet_helpers import fill_bag, place

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def shop(client, catalogue, customer, other_customer, settings_documents, admin_auth, auth, db):
    # Offers by email and in the bell are on by default. These tests count who
    # is reached exactly, so both customers start by having said no, and each
    # test opts in whoever it needs (which also shows a "no" is respected).
    for customer_id in ("CUS001", "CUS002"):
        for channel in ("email", "in_app"):
            messaging.set_consent(db, customer_id, channel, "marketing", False, source="test")
    db.commit()
    return client


def opt_in(db, customer_id, *channels):
    for channel in channels:
        messaging.set_consent(db, customer_id, channel, "marketing", True, source="test")
    db.commit()


def draft(client, admin_auth, *, channels=("email",), audience=None, **extra):
    body = {
        "name": "Festive edit", "kind": "promotional", "channels": list(channels), "audience": audience or {},
        "content": {
            "email": {"subject": "Hi {{customer_name}} — the festive edit", "heading": "The festive edit",
                      "html": "<p>Hello {{customer_name}}, <a href=\"https://shop.test/new\">see what's new</a>.</p>",
                      "ctaLabel": "Shop now", "ctaUrl": "/shop", "preview": "New arrivals"},
            "sms": {"text": "{{store_name}}: the festive edit is here."},
            "whatsapp": {"template": "festive_edit", "language": "en", "variables": ["customer_name"]},
            "in_app": {"title": "The festive edit", "body": "New arrivals are in.", "url": "/shop"},
        },
        **extra,
    }
    response = client.post("/api/admin/campaigns", headers=admin_auth, json=body)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def estimate(client, admin_auth, audience, channels):
    response = client.post("/api/admin/campaigns/estimate", headers=admin_auth,
                           json={"audience": audience, "channels": channels})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def launch_after_test(client, admin_auth, campaign_id, messages, **extra):
    test = client.post(f"/api/admin/campaigns/{campaign_id}/test", headers=admin_auth,
                       json={"email": "owner@example.com", "phone": "+919000000001"})
    assert test.status_code == 200, test.text
    return client.post(f"/api/admin/campaigns/{campaign_id}/launch", headers=admin_auth,
                       json={"confirmMessages": messages, **extra})


class TestBuilding:
    def test_a_campaign_is_saved_as_a_draft_and_validated(self, shop, admin_auth):
        created = draft(shop, admin_auth)
        assert created["status"] == "draft" and created["readiness"]
        bad = shop.post("/api/admin/campaigns", headers=admin_auth, json={"name": "x", "channels": ["email"]})
        assert bad.status_code == 422
        unknown = shop.post("/api/admin/campaigns", headers=admin_auth, json={
            "name": "Bad vars", "channels": ["email"], "content": {"email": {"subject": "Hi {{password}}"}}})
        assert unknown.status_code == 422 and unknown.json()["error_code"] == "INVALID_TEMPLATE_VARIABLE"

    def test_scripts_are_stripped_from_the_email_html(self, shop, admin_auth, db):
        created = draft(shop, admin_auth)
        shop.put(f"/api/admin/campaigns/{created['id']}", headers=admin_auth, json={
            "name": "Festive edit", "channels": ["email"],
            "content": {"email": {"subject": "S", "html": "<p>Hi</p><script>steal()</script><img src=x onerror=y>"}}})
        db.expire_all()
        html = db.get(MarketingCampaign, created["id"]).content["email"]["html"]
        assert "script" not in html and "onerror" not in html

    def test_only_permitted_staff_reach_campaigns(self, shop, editor, client, auth):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}).json()
        headers = {"Authorization": f"Bearer {token['data']['token']['accessToken']}"}
        assert shop.get("/api/admin/campaigns", headers=headers).status_code == 403
        assert shop.get("/api/admin/campaigns", headers=auth).status_code == 403


class TestAudience:
    def test_offers_reach_everyone_by_default_except_who_turned_them_off(self, client, catalogue, customer,
                                                                          other_customer, settings_documents,
                                                                          admin_auth, db):
        figures = estimate(client, admin_auth, {"segment": "all"}, ["email", "in_app", "sms"])
        assert figures["channels"] == {"email": 2, "in_app": 2, "sms": 0}  # SMS offers stay opt-in
        messaging.set_consent(db, "CUS002", "email", "marketing", False, source="unsubscribe-link")
        db.commit()
        figures = estimate(client, admin_auth, {"segment": "all"}, ["email", "in_app"])
        assert figures["channels"] == {"email": 1, "in_app": 2}

    def test_consent_decides_who_is_reached(self, shop, admin_auth, db):
        figures = estimate(shop, admin_auth, {"segment": "all"}, ["email", "sms"])
        assert figures["matching"] == 2 and figures["messages"] == 0  # nobody opted in yet
        opt_in(db, "CUS001", "email", "sms")
        figures = estimate(shop, admin_auth, {"segment": "all"}, ["email", "sms"])
        assert figures["channels"] == {"email": 1, "sms": 1} and figures["messages"] == 2

    def test_filters_by_orders_spend_and_product(self, shop, auth, admin_auth, db):
        opt_in(db, "CUS001", "email")
        opt_in(db, "CUS002", "email")
        fill_bag(shop, auth, "PRD001", 2)
        place(shop, auth)
        assert estimate(shop, admin_auth, {"minOrders": 1}, ["email"])["channels"]["email"] == 1
        assert estimate(shop, admin_auth, {"minSpent": 1500}, ["email"])["channels"]["email"] == 1
        assert estimate(shop, admin_auth, {"minSpent": 5000}, ["email"])["channels"]["email"] == 0
        assert estimate(shop, admin_auth, {"productIds": ["PRD001"]}, ["email"])["channels"]["email"] == 1
        assert estimate(shop, admin_auth, {"categoryIds": ["CAT002"]}, ["email"])["channels"]["email"] == 0
        assert estimate(shop, admin_auth, {"segment": "repeat"}, ["email"])["channels"]["email"] == 0
        assert estimate(shop, admin_auth, {"maxOrders": 0}, ["email"])["channels"]["email"] == 1
        bad = shop.post("/api/admin/campaigns/estimate", headers=admin_auth,
                        json={"audience": {"minSpent": 10, "maxSpent": 1}, "channels": ["email"]})
        assert bad.status_code == 422

    def test_members_and_abandoned_bags(self, shop, admin_auth, db):
        from app.models import CartRecovery, CustomerMembership

        opt_in(db, "CUS001", "email")
        opt_in(db, "CUS002", "email")
        now = datetime.utcnow()
        db.add(CartRecovery(customer_id="CUS002", status="abandoned", started_at=now, last_activity_at=now,
                            abandoned_at=now, item_count=1, cart_value=100000, reminders_sent=0,
                            created_at=now, updated_at=now))
        db.flush()
        assert estimate(shop, admin_auth, {"abandonedCart": True}, ["email"])["channels"]["email"] == 1
        assert estimate(shop, admin_auth, {"segment": "members"}, ["email"])["channels"]["email"] == 0
        assert estimate(shop, admin_auth, {"segment": "non_members"}, ["email"])["channels"]["email"] == 2
        _ = CustomerMembership


class TestLaunching:
    def test_launch_needs_a_test_and_the_confirmed_count(self, shop, admin_auth, db, email_account):  # noqa: F811
        opt_in(db, "CUS001", "email")
        created = draft(shop, admin_auth)
        untested = shop.post(f"/api/admin/campaigns/{created['id']}/launch", headers=admin_auth,
                             json={"confirmMessages": 1})
        assert untested.status_code == 422 and untested.json()["error_code"] == "CAMPAIGN_NOT_READY"
        wrong = launch_after_test(shop, admin_auth, created["id"], 5)
        assert wrong.status_code == 409 and wrong.json()["error_code"] == "AUDIENCE_CHANGED"
        assert email_account.sent[-1]["subject"].startswith("[Test]")
        assert email_account.sent[-1]["to"] == "owner@example.com"  # the test never reaches customers

    def test_an_edit_after_the_test_needs_a_new_test(self, shop, admin_auth, db, email_account):  # noqa: F811
        opt_in(db, "CUS001", "email")
        created = draft(shop, admin_auth)
        shop.post(f"/api/admin/campaigns/{created['id']}/test", headers=admin_auth, json={"email": "o@example.com"})
        db.expire_all()
        campaign = db.get(MarketingCampaign, created["id"])
        campaign.tested_at = datetime.utcnow() - timedelta(minutes=5)
        db.commit()
        shop.put(f"/api/admin/campaigns/{created['id']}", headers=admin_auth, json={
            "name": "Festive edit", "channels": ["email"],
            "content": {"email": {"subject": "Changed", "html": "<p>Changed</p>"}}})
        launch = shop.post(f"/api/admin/campaigns/{created['id']}/launch", headers=admin_auth, json={"confirmMessages": 1})
        assert launch.status_code == 422 and "test" in launch.json()["message"].lower()

    def test_sending_is_once_per_recipient_even_when_the_job_runs_again(self, shop, admin_auth, db, email_account,
                                                                       sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        opt_in(db, "CUS001", "email", "sms", "in_app")
        opt_in(db, "CUS002", "email")
        created = draft(shop, admin_auth, channels=("email", "sms", "in_app"))
        launch = launch_after_test(shop, admin_auth, created["id"], 4)
        assert launch.status_code == 200, launch.text
        assert launch.json()["data"]["status"] == "sending"
        again = shop.post(f"/api/admin/campaigns/{created['id']}/launch", headers=admin_auth, json={"confirmMessages": 4})
        assert again.status_code == 409 and again.json()["error_code"] == "CAMPAIGN_ALREADY_LAUNCHED"
        before = len(email_account.sent)
        campaigns.run_due(db)
        campaigns.run_due(db)  # a restart, a retry
        db.expire_all()
        assert db.query(CampaignRecipient).filter_by(campaign_id=created["id"]).count() == 4
        assert db.query(NotificationDelivery).filter_by(campaign_id=created["id"]).count() == 4
        mails = email_account.sent[before:]
        assert sorted(m["to"] for m in mails) == ["shopper@example.com", "someone.else@example.com"]
        assert "Unsubscribe" in mails[0]["html"] and "/unsubscribe?token=" in mails[0]["html"]
        assert "/r/" in mails[0]["html"]  # links go through click tracking
        assert len([m for m in sms.sent if "festive" in m.text and not m.text.startswith("[Test]")]) == 1
        assert db.query(CustomerNotification).filter_by(customer_id="CUS001", kind="campaign").count() == 1
        assert db.get(MarketingCampaign, created["id"]).status == "sent"

    def test_a_scheduled_campaign_waits_and_can_be_cancelled(self, shop, admin_auth, db, email_account):  # noqa: F811
        opt_in(db, "CUS001", "email")
        created = draft(shop, admin_auth)
        later = (datetime.utcnow() + timedelta(hours=2)).replace(microsecond=0).isoformat() + "Z"
        launch = launch_after_test(shop, admin_auth, created["id"], 1, sendAt=later)
        assert launch.json()["data"]["status"] == "scheduled"
        assert campaigns.run_due(db) == 0
        cancel = shop.post(f"/api/admin/campaigns/{created['id']}/cancel", headers=admin_auth)
        assert cancel.json()["data"]["status"] == "cancelled"
        db.expire_all()
        campaign = db.get(MarketingCampaign, created["id"])
        campaign.scheduled_at = datetime.utcnow() - timedelta(minutes=1)
        db.commit()
        assert campaigns.run_due(db) == 0
        assert db.query(CampaignRecipient).filter_by(campaign_id=created["id"]).count() == 0

    def test_customers_who_opt_out_before_sending_are_left_out(self, shop, admin_auth, db, email_account):  # noqa: F811
        opt_in(db, "CUS001", "email")
        opt_in(db, "CUS002", "email")
        created = draft(shop, admin_auth)
        later = (datetime.utcnow() + timedelta(hours=1)).replace(microsecond=0).isoformat() + "Z"
        launch_after_test(shop, admin_auth, created["id"], 2, sendAt=later)
        messaging.set_consent(db, "CUS002", "email", "marketing", False, source="test")
        db.get(MarketingCampaign, created["id"]).scheduled_at = datetime.utcnow() - timedelta(minutes=1)
        db.commit()
        campaigns.run_due(db)
        assert [r.customer_id for r in db.query(CampaignRecipient).filter_by(campaign_id=created["id"])] == ["CUS001"]

    def test_failed_deliveries_are_counted_not_hidden(self, shop, admin_auth, db, email_account, sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        opt_in(db, "CUS001", "sms")
        created = draft(shop, admin_auth, channels=("sms",))
        launch_after_test(shop, admin_auth, created["id"], 1)
        sms.fail_with = providers.ProviderError("Invalid number", transient=False)
        campaigns.run_due(db)
        detail = shop.get(f"/api/admin/campaigns/{created['id']}", headers=admin_auth).json()["data"]
        figures = detail["analytics"]["channels"]["sms"]
        assert figures["targeted"] == 1 and figures["failed"] == 1 and figures["sent"] == 0
        assert figures["rates"]["failure"] == 100.0
        assert figures["opened"] is None and figures["replied"] is None  # not something SMS can report


class TestAnalytics:
    def test_opens_clicks_unsubscribes_bounces_and_revenue(self, shop, auth, admin_auth, db, email_account,
                                                          monkeypatch):  # noqa: F811
        from app.core.config import settings

        monkeypatch.setattr(settings, "PUBLIC_API_URL", "https://api.shop.test")
        opt_in(db, "CUS001", "email")
        opt_in(db, "CUS002", "email")
        created = draft(shop, admin_auth)
        launch_after_test(shop, admin_auth, created["id"], 2)
        campaigns.run_due(db)
        email_account.run()
        mine = db.query(CampaignRecipient).filter_by(campaign_id=created["id"], customer_id="CUS001").one()
        theirs = db.query(CampaignRecipient).filter_by(campaign_id=created["id"], customer_id="CUS002").one()
        assert shop.get(f"/api/c/o/{mine.token}.gif").headers["content-type"] == "image/gif"
        target = "http://localhost:3000/shop"
        sig = campaigns._click_signature(mine.token, target)
        assert shop.post("/api/campaigns/click", json={"token": mine.token, "to": "https://evil.test", "s": sig}).status_code == 422
        click = shop.post("/api/campaigns/click", json={"token": mine.token, "to": target, "s": sig})
        assert click.json()["data"]["url"] == target
        # The other recipient unsubscribes, and their email bounced.
        token = messaging.unsubscribe_token("CUS002", "email", created["id"])
        shop.post("/api/notifications/unsubscribe", json={"token": token})
        log = db.query(EmailLog).filter(EmailLog.delivery_id == theirs.delivery_id).first()
        log.bounced_at = datetime.utcnow()
        db.commit()
        # The clicker buys within the week.
        fill_bag(shop, auth, "PRD001")
        order = place(shop, auth)["order"]
        detail = shop.get(f"/api/admin/campaigns/{created['id']}", headers=admin_auth).json()["data"]
        email = detail["analytics"]["channels"]["email"]
        assert email["sent"] == 2 and email["opened"] == 1 and email["clicked"] == 1
        assert email["unsubscribed"] == 1 and email["bounced"] == 1 and email["delivered"] is None
        assert email["rates"]["open"] == 50.0 and email["rates"]["click"] == 50.0
        assert detail["analytics"]["revenue"] == {"orders": 1, "revenue": order["totals"]["total"]}
        recipients = shop.get(f"/api/admin/campaigns/{created['id']}/recipients", headers=admin_auth).json()["data"]
        assert recipients["pagination"]["total"] == 2

    def test_opens_are_reported_as_unavailable_without_a_public_api_address(self, shop, admin_auth, db,
                                                                            email_account):  # noqa: F811
        opt_in(db, "CUS001", "email")
        created = draft(shop, admin_auth)
        launch_after_test(shop, admin_auth, created["id"], 1)
        campaigns.run_due(db)
        detail = shop.get(f"/api/admin/campaigns/{created['id']}", headers=admin_auth).json()["data"]
        assert detail["analytics"]["channels"]["email"]["opened"] is None
        assert detail["analytics"]["notes"]
        _ = Customer
