"""
Marketing campaigns beyond the happy path: every audience filter and its
validation, reachability per channel, draft validation and the draft-only
rules for editing, copying and deleting, previews and test sends on every
channel (and their failures), launch refusals, cancelling while sending,
the sending job's failure handling and completion, open/click tracking edge
cases, coupon-based revenue attribution, listings and the background loop.
"""

from __future__ import annotations

import asyncio
import types
from datetime import datetime, timedelta

import pytest

from app.models import (
    CampaignRecipient,
    Customer,
    MarketingCampaign,
    Notification,
    NotificationDelivery,
    Order,
)
from app.services.messaging import campaigns, providers, service as messaging
from tests.integration.messaging_helpers import email_account, sms_whatsapp  # noqa: F401
from tests.integration.test_campaigns import _fresh_limits, draft, estimate, launch_after_test, opt_in, shop  # noqa: F401
from tests.integration.wallet_helpers import fill_bag, place

pytestmark = pytest.mark.integration


def fresh(db, row):
    db.expire_all()
    return db.get(type(row), row.id)


def audience_error(client, admin_auth, audience):
    response = client.post("/api/admin/campaigns/estimate", headers=admin_auth,
                           json={"audience": audience, "channels": ["email"]})
    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "INVALID_AUDIENCE"
    return response.json()["message"]


def create(client, admin_auth, body):
    return client.post("/api/admin/campaigns", headers=admin_auth, json=body)


def in_app_campaign(client, admin_auth, **extra):
    body = {"name": "Bell only", "kind": "announcement", "channels": ["in_app"], "audience": {},
            "content": {"in_app": {"title": "News", "body": "Hello {{customer_name}}", "url": "/shop"}}, **extra}
    response = create(client, admin_auth, body)
    assert response.status_code == 201, response.text
    return response.json()["data"]


class Detached:
    """The test session seen as a fresh one: not marked as the test's, and not closed when 'closed'."""

    def __init__(self, session):
        self._session = session
        self.info = {}

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __getattr__(self, name):
        return getattr(self._session, name)


# ----------------------------------------------------------------- audience


class TestAudienceValidation:
    @pytest.mark.parametrize("audience, words", [
        ({"segment": "vips"}, "Choose who"),
        ({"joinedWithinDays": "soon"}, "must be a number"),
        ({"minSpent": -5}, "can't be negative"),
        ({"orderedFrom": "2026-13-45"}, "isn't a date"),
        ({"minOrders": 3, "maxOrders": 1}, "fewest orders"),
    ])
    def test_a_bad_filter_is_refused_with_the_reason(self, shop, admin_auth, audience, words):
        assert words in audience_error(shop, admin_auth, audience)

    def test_campaign_pages_need_staff_access(self, client, customer, auth):
        assert client.post("/api/admin/campaigns/estimate", json={"audience": {}, "channels": ["email"]}).status_code == 401
        assert client.post("/api/admin/campaigns/estimate", headers=auth,
                           json={"audience": {}, "channels": ["email"]}).status_code in (401, 403)


class TestAudienceFilters:
    @pytest.fixture()
    def everyone_opted_in(self, shop, db):
        opt_in(db, "CUS001", "email")
        opt_in(db, "CUS002", "email")
        return shop

    def emails(self, client, admin_auth, audience):
        return estimate(client, admin_auth, audience, ["email"])["channels"]["email"]

    def test_new_customers_by_join_date(self, everyone_opted_in, db, admin_auth):
        db.get(Customer, "CUS002").joined_at = datetime.utcnow() - timedelta(days=5)
        db.commit()
        assert self.emails(everyone_opted_in, admin_auth, {"segment": "new"}) == 1
        assert self.emails(everyone_opted_in, admin_auth, {"segment": "new", "joinedWithinDays": 2}) == 0
        assert self.emails(everyone_opted_in, admin_auth, {"segment": "all", "joinedWithinDays": 10}) == 1

    def test_lapsed_and_not_ordered_lately(self, everyone_opted_in, db, auth, admin_auth):
        fill_bag(everyone_opted_in, auth, "PRD001")
        order_id = place(everyone_opted_in, auth, method="cod")["order"]["id"]
        # A recent order: not lapsed; "not ordered for 30 days" leaves out only the recent buyer.
        assert self.emails(everyone_opted_in, admin_auth, {"segment": "lapsed"}) == 0
        assert self.emails(everyone_opted_in, admin_auth, {"notOrderedDays": 30}) == 1
        db.get(Order, order_id).placed_at = datetime.utcnow() - timedelta(days=120)
        db.commit()
        assert self.emails(everyone_opted_in, admin_auth, {"segment": "lapsed"}) == 1
        assert self.emails(everyone_opted_in, admin_auth, {"segment": "lapsed", "notOrderedDays": 200}) == 0
        assert self.emails(everyone_opted_in, admin_auth, {"notOrderedDays": 30}) == 2

    def test_an_order_window_and_a_spend_ceiling(self, everyone_opted_in, db, auth, admin_auth):
        fill_bag(everyone_opted_in, auth, "PRD001")
        place(everyone_opted_in, auth, method="cod")
        # Dates in filters are days in India (UTC+5:30).
        ist_now = datetime.utcnow() + timedelta(hours=5, minutes=30)
        today = ist_now.strftime("%Y-%m-%d")
        last_year = (ist_now - timedelta(days=365)).strftime("%Y-%m-%d")
        assert self.emails(everyone_opted_in, admin_auth, {"orderedFrom": last_year, "orderedTo": today}) == 1
        assert self.emails(everyone_opted_in, admin_auth, {"orderedTo": last_year}) == 0
        assert self.emails(everyone_opted_in, admin_auth, {"orderedFrom": today}) == 1
        # Spent at most 500: the customer who never ordered (spent 0) only.
        assert self.emails(everyone_opted_in, admin_auth, {"maxSpent": 500}) == 1

    def test_members_of_a_given_plan(self, everyone_opted_in, db, admin_auth):
        from app.models import CustomerMembership, MembershipPlan

        now = datetime.utcnow()
        db.add(MembershipPlan(id="MPL001", name="Yearly", duration_months=12, price=999, created_at=now,
                              updated_at=now))
        db.flush()
        db.add(CustomerMembership(id="MEM001", customer_id="CUS001", plan_id="MPL001", plan_name="Yearly",
                                  duration_months=12, status="active", starts_at=now - timedelta(days=1),
                                  ends_at=now + timedelta(days=300), amount=99900, benefits={}, created_at=now,
                                  updated_at=now))
        db.commit()
        assert self.emails(everyone_opted_in, admin_auth, {"membershipPlanIds": ["MPL001"]}) == 1
        assert self.emails(everyone_opted_in, admin_auth, {"membershipPlanIds": ["MPL999"]}) == 0
        assert self.emails(everyone_opted_in, admin_auth, {"segment": "members"}) == 1

    def test_customers_who_cannot_be_reached_on_a_channel_are_excluded(self, shop, db, admin_auth):
        opt_in(db, "CUS001", "email", "sms")
        opt_in(db, "CUS002", "email", "sms")
        db.get(Customer, "CUS002").email = "no-at-sign"
        db.get(Customer, "CUS002").phone = "12"
        db.commit()
        figures = estimate(shop, admin_auth, {}, ["email", "sms", "fax"])
        assert figures["channels"] == {"email": 1, "sms": 1}
        assert figures["excluded"] == {"email": 1, "sms": 1}
        assert figures["messages"] == 2 and figures["capped"] is False

    def test_an_empty_audience_reaches_nobody_on_any_channel(self, db):
        assert campaigns.reachable(db, [], ["email", "sms"]) == {"email": [], "sms": []}


# ------------------------------------------------------------------ drafts


class TestDrafts:
    BASE = {"name": "Festive", "kind": "promotional", "channels": ["email"],
            "content": {"email": {"subject": "S", "html": "<p>x</p>"}}}

    @pytest.mark.parametrize("change, code", [
        ({"kind": "spam"}, "INVALID_CAMPAIGN"),
        ({"channels": ["fax"]}, "INVALID_CAMPAIGN"),
        ({"startsAt": "2026-11-02T10:00:00Z", "endsAt": "2026-11-01T10:00:00Z"}, "INVALID_CAMPAIGN"),
        ({"startsAt": "next tuesday"}, "INVALID_DATE"),
        ({"content": {"email": {"subject": "S", "ctaUrl": "javascript:alert(1)"}}}, "INVALID_CONTENT"),
    ])
    def test_an_invalid_draft_is_refused_and_not_saved(self, shop, db, admin_auth, change, code):
        response = create(shop, admin_auth, {**self.BASE, **change})
        assert response.status_code == 422 and response.json()["error_code"] == code
        assert db.query(MarketingCampaign).count() == 0

    def test_dates_and_coupon_are_kept(self, shop, admin_auth):
        response = create(shop, admin_auth, {**self.BASE, "couponCode": " save10 ",
                                             "startsAt": "2026-11-01T10:00:00Z", "endsAt": "2026-11-05T10:00:00Z"})
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert data["couponCode"] == "SAVE10" and data["startsAt"].startswith("2026-11-01")

    def test_an_unknown_campaign_is_not_found_everywhere(self, shop, admin_auth):
        for response in (shop.get("/api/admin/campaigns/9999", headers=admin_auth),
                         shop.put("/api/admin/campaigns/9999", headers=admin_auth, json=self.BASE),
                         shop.delete("/api/admin/campaigns/9999", headers=admin_auth),
                         shop.post("/api/admin/campaigns/9999/duplicate", headers=admin_auth),
                         shop.get("/api/admin/campaigns/9999/preview", headers=admin_auth),
                         shop.get("/api/admin/campaigns/9999/recipients", headers=admin_auth),
                         shop.post("/api/admin/campaigns/9999/cancel", headers=admin_auth)):
            assert response.status_code == 404 and response.json()["error_code"] == "CAMPAIGN_NOT_FOUND"

    def test_a_copy_is_a_new_draft_with_the_same_content(self, shop, db, admin_auth):
        original = draft(shop, admin_auth, couponCode="SAVE10")
        response = shop.post(f"/api/admin/campaigns/{original['id']}/duplicate", headers=admin_auth)
        assert response.status_code == 201, response.text
        copy = response.json()["data"]
        assert copy["id"] != original["id"] and copy["name"] == "Festive edit (copy)"
        assert copy["status"] == "draft" and copy["content"] == original["content"]
        assert copy["couponCode"] == "SAVE10" and copy["testedAt"] is None
        assert db.query(MarketingCampaign).count() == 2

    def test_a_draft_can_be_deleted(self, shop, db, admin_auth):
        created = draft(shop, admin_auth)
        response = shop.delete(f"/api/admin/campaigns/{created['id']}", headers=admin_auth)
        assert response.status_code == 200 and response.json()["message"] == "Campaign deleted."
        db.expire_all()
        assert db.get(MarketingCampaign, created["id"]) is None
        from app.models import AuditLog

        assert db.query(AuditLog).filter_by(action="campaign.delete").count() == 1

    def test_a_launched_campaign_cannot_be_changed_or_deleted(self, shop, db, admin_auth):
        opt_in(db, "CUS001", "in_app")
        created = in_app_campaign(shop, admin_auth)
        launched = shop.post(f"/api/admin/campaigns/{created['id']}/launch", headers=admin_auth,
                             json={"confirmMessages": 1})
        assert launched.status_code == 200, launched.text
        edit = shop.put(f"/api/admin/campaigns/{created['id']}", headers=admin_auth, json=self.BASE)
        assert edit.status_code == 409 and edit.json()["error_code"] == "CAMPAIGN_NOT_DRAFT"
        delete = shop.delete(f"/api/admin/campaigns/{created['id']}", headers=admin_auth)
        assert delete.status_code == 409 and delete.json()["error_code"] == "CAMPAIGN_NOT_DRAFT"
        db.expire_all()
        assert db.get(MarketingCampaign, created["id"]).name == "Bell only"

    def test_the_options_describe_what_a_campaign_can_use(self, shop, admin_auth, catalogue):
        response = shop.get("/api/admin/campaigns/options", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert {k["value"] for k in data["kinds"]} == set(campaigns.KINDS)
        assert data["segments"] == list(campaigns.SEGMENTS) and data["variables"] == campaigns.VARIABLES
        assert [c["id"] for c in data["categories"]] == ["CAT002", "CAT001"]  # by name: Electronics, Women
        assert data["channels"]["sms"]["configured"] is False and data["openTracking"] is False
        assert data["starters"]["discount"]["message"].startswith("Use code")


# ------------------------------------------------------- preview & testing


class TestPreviewAndTests:
    def test_each_channel_is_previewed_for_a_sample_customer(self, shop, admin_auth):
        created = draft(shop, admin_auth, channels=("email", "sms", "whatsapp", "in_app"))
        response = shop.get(f"/api/admin/campaigns/{created['id']}/preview", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["email"]["subject"] == "Hi Asha \u2014 the festive edit"
        assert data["whatsapp"] == {"template": "festive_edit", "language": "en", "variables": ["Asha"]}
        assert data["sms"]["text"].endswith("Reply STOP to opt out.")
        assert data["in_app"]["href"] == "/shop"

    def test_content_that_no_longer_renders_is_shown_as_a_problem(self, shop, db, admin_auth):
        created = draft(shop, admin_auth, channels=("email", "in_app"))
        row = db.get(MarketingCampaign, created["id"])
        row.content = {**row.content, "email": {**row.content["email"], "html": "<p>{{retired_variable}}</p>"}}
        db.commit()
        data = shop.get(f"/api/admin/campaigns/{created['id']}/preview", headers=admin_auth).json()["data"]
        assert "problem" in data["email"] and "retired_variable" in data["email"]["problem"]
        assert data["in_app"]["title"] == "The festive edit"

    def _test(self, client, admin_auth, campaign_id, **body):
        return client.post(f"/api/admin/campaigns/{campaign_id}/test", headers=admin_auth, json=body)

    def test_an_email_test_needs_an_address_and_an_account(self, shop, admin_auth):
        created = draft(shop, admin_auth)
        missing = self._test(shop, admin_auth, created["id"], email="")
        assert missing.status_code == 422 and missing.json()["error_code"] == "INVALID_RECIPIENT"
        no_account = self._test(shop, admin_auth, created["id"], email="owner@example.com")
        assert no_account.status_code == 422 and no_account.json()["error_code"] == "EMAIL_NOT_CONFIGURED"

    def test_a_refused_test_email_is_reported_and_not_counted(self, shop, db, admin_auth, email_account):  # noqa: F811
        from app.services.email.senders import SendError

        created = draft(shop, admin_auth)
        email_account.fail_with = SendError("Authentication failed")
        response = self._test(shop, admin_auth, created["id"], email="owner@example.com")
        assert response.status_code == 422 and response.json()["error_code"] == "TEST_SEND_FAILED"
        db.expire_all()
        assert db.get(MarketingCampaign, created["id"]).tested_at is None

    def test_a_text_test_needs_a_number_and_a_working_provider(self, shop, db, admin_auth, sms_whatsapp):  # noqa: F811
        sms, whatsapp = sms_whatsapp
        created = draft(shop, admin_auth, channels=("sms", "whatsapp", "in_app"))
        bad = self._test(shop, admin_auth, created["id"], phone="123")
        assert bad.status_code == 422 and bad.json()["error_code"] == "INVALID_RECIPIENT"
        sms.fail_with = providers.ProviderError("Unverified number", transient=False)
        refused = self._test(shop, admin_auth, created["id"], phone="+919000000001")
        assert refused.status_code == 422 and "Unverified number" in refused.json()["message"]
        sms.fail_with = None
        sent = self._test(shop, admin_auth, created["id"], phone="+919000000001")
        assert sent.status_code == 200, sent.text
        channels = [s["channel"] for s in sent.json()["data"]["sent"]]
        assert channels == ["sms", "whatsapp", "in_app"]
        assert sent.json()["data"]["sent"][2]["to"] == "preview only"
        assert whatsapp.sent[0].template == "festive_edit" and whatsapp.sent[0].to == "+919000000001"
        assert sms.sent[0].text.startswith("[Test] ")
        db.expire_all()
        assert db.get(MarketingCampaign, created["id"]).tested_at is not None

    def test_a_test_of_incomplete_content_is_refused(self, shop, admin_auth):
        response = create(shop, admin_auth, {"name": "Empty", "channels": ["sms"], "content": {}})
        response = self._test(shop, admin_auth, response.json()["data"]["id"], phone="+919000000001")
        assert response.status_code == 422 and response.json()["error_code"] == "CONTENT_REQUIRED"


# ------------------------------------------------------------------ launch


class TestLaunchRefusals:
    def test_an_unconfigured_channel_blocks_the_launch(self, shop, db, admin_auth):
        opt_in(db, "CUS001", "sms")
        created = draft(shop, admin_auth, channels=("sms",))
        assert any(p.startswith("sms: ") for p in created["readiness"])
        response = shop.post(f"/api/admin/campaigns/{created['id']}/launch", headers=admin_auth,
                             json={"confirmMessages": 1})
        assert response.status_code == 422 and response.json()["error_code"] == "CAMPAIGN_NOT_READY"
        assert any("No SMS provider" in p for p in response.json()["details"]["problems"])

    def test_nobody_opted_in_means_no_launch(self, shop, db, admin_auth, email_account):  # noqa: F811
        created = draft(shop, admin_auth)
        response = launch_after_test(shop, admin_auth, created["id"], 0)
        assert response.status_code == 422 and response.json()["error_code"] == "CAMPAIGN_NO_AUDIENCE"
        db.expire_all()
        assert db.get(MarketingCampaign, created["id"]).status == "draft"

    def test_a_send_time_in_the_past_is_refused(self, shop, db, admin_auth):
        opt_in(db, "CUS001", "in_app")
        created = in_app_campaign(shop, admin_auth)
        past = (datetime.utcnow() - timedelta(hours=1)).replace(microsecond=0).isoformat() + "Z"
        response = shop.post(f"/api/admin/campaigns/{created['id']}/launch", headers=admin_auth,
                             json={"confirmMessages": 1, "sendAt": past})
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_DATE"
        db.expire_all()
        row = db.get(MarketingCampaign, created["id"])
        assert row.status == "draft" and row.launch_key is None

    def test_a_bell_only_campaign_needs_no_test(self, shop, db, admin_auth):
        opt_in(db, "CUS001", "in_app")
        created = in_app_campaign(shop, admin_auth)
        assert created["readiness"] == []
        response = shop.post(f"/api/admin/campaigns/{created['id']}/launch", headers=admin_auth,
                             json={"confirmMessages": 1})
        assert response.status_code == 200 and response.json()["message"] == "Campaign is sending."
        campaigns.run_due(db)
        db.expire_all()
        row = db.get(MarketingCampaign, created["id"])
        assert row.status == "sent" and row.recipients_total == 1
        [delivery] = db.query(NotificationDelivery).filter_by(campaign_id=row.id).all()
        assert delivery.status == "delivered" and delivery.provider == "bell"


# ------------------------------------------------------------ sending job


class TestSendingJob:
    def _sending_sms(self, shop, db, admin_auth, sms):
        opt_in(db, "CUS001", "sms")
        created = draft(shop, admin_auth, channels=("sms",))
        launch = launch_after_test(shop, admin_auth, created["id"], 1)
        assert launch.status_code == 200, launch.text
        sms.fail_with = providers.ProviderError("Rate limited", transient=True)
        campaigns.run_due(db)
        return created["id"]

    def test_a_campaign_with_retrying_messages_stays_sending_until_they_go(self, shop, db, admin_auth,
                                                                           email_account, sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        campaign_id = self._sending_sms(shop, db, admin_auth, sms)
        db.expire_all()
        assert db.get(MarketingCampaign, campaign_id).status == "sending"
        [row] = db.query(NotificationDelivery).filter_by(campaign_id=campaign_id).all()
        assert row.status == "failed"
        sms.fail_with = None
        row.next_attempt_at = datetime.utcnow() - timedelta(seconds=5)
        db.commit()
        messaging.process(db)
        assert campaigns.run_due(db) == 0  # nobody new to queue
        db.expire_all()
        campaign = db.get(MarketingCampaign, campaign_id)
        assert campaign.status == "sent" and campaign.completed_at is not None
        assert db.query(CampaignRecipient).filter_by(campaign_id=campaign_id).one().status == "sent"

    def test_cancelling_while_sending_skips_what_is_left(self, shop, db, admin_auth, email_account,
                                                         sms_whatsapp):  # noqa: F811
        sms, _ = sms_whatsapp
        campaign_id = self._sending_sms(shop, db, admin_auth, sms)
        response = shop.post(f"/api/admin/campaigns/{campaign_id}/cancel", headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["status"] == "cancelled"
        db.expire_all()
        [row] = db.query(NotificationDelivery).filter_by(campaign_id=campaign_id).all()
        assert row.status == "skipped" and row.last_error == "Campaign cancelled." and row.next_attempt_at is None
        again = shop.post(f"/api/admin/campaigns/{campaign_id}/cancel", headers=admin_auth)
        assert again.status_code == 409 and again.json()["error_code"] == "CAMPAIGN_FINISHED"

    def test_a_campaign_that_cannot_be_sent_is_marked_failed_and_staff_told(self, shop, db, admin, admin_auth,
                                                                            monkeypatch):
        opt_in(db, "CUS001", "in_app")
        created = in_app_campaign(shop, admin_auth)
        shop.post(f"/api/admin/campaigns/{created['id']}/launch", headers=admin_auth, json={"confirmMessages": 1})

        def broken(session, campaign):
            raise RuntimeError("template store unavailable")

        monkeypatch.setattr(campaigns, "_materialise", broken)
        assert campaigns.run_due(db) == 0
        db.expire_all()
        row = db.get(MarketingCampaign, created["id"])
        assert row.status == "failed" and row.last_error == "RuntimeError: template store unavailable"
        alerts = db.query(Notification).filter_by(kind="campaign").all()
        assert len(alerts) == 1 and alerts[0].title == "Campaign failed: Bell only"
        # A failed campaign is not picked up again.
        monkeypatch.undo()
        assert campaigns.run_due(db) == 0

    def test_a_finished_campaign_is_left_alone_by_the_finisher(self, shop, db, admin_auth):
        created = draft(shop, admin_auth)
        campaigns._maybe_finish(db, created["id"])
        campaigns._maybe_finish(db, 987654)
        db.expire_all()
        assert db.get(MarketingCampaign, created["id"]).status == "draft"

    def test_send_now_starts_a_launched_campaign_in_its_own_session(self, shop, db, admin_auth, monkeypatch):
        from app.core import database as db_module

        opt_in(db, "CUS001", "in_app")
        created = in_app_campaign(shop, admin_auth)
        shop.post(f"/api/admin/campaigns/{created['id']}/launch", headers=admin_auth, json={"confirmMessages": 1})
        monkeypatch.setattr(db_module, "SessionLocal", lambda: Detached(db))
        campaigns.send_now()
        db.expire_all()
        assert db.get(MarketingCampaign, created["id"]).status == "sent"
        assert db.query(CampaignRecipient).filter_by(campaign_id=created["id"]).count() == 1

    def test_send_now_never_raises(self, db, monkeypatch, caplog):
        from app.core import database as db_module

        monkeypatch.setattr(db_module, "SessionLocal", lambda: Detached(db))

        def broken(session):
            raise RuntimeError("lock wait timeout")

        monkeypatch.setattr(campaigns, "run_due", broken)
        campaigns.send_now()
        assert "the job will retry it" in caplog.text

    def test_send_now_leaves_the_test_session_to_the_tests(self, db, monkeypatch):
        calls = []
        monkeypatch.setattr(campaigns, "run_due", lambda session: calls.append(session))
        campaigns.send_now()
        assert calls == []

    def test_one_pass_rolls_back_and_raises_on_error(self, db, monkeypatch):
        from app.core import database as db_module

        monkeypatch.setattr(db_module, "SessionLocal", lambda: Detached(db))
        calls = []
        monkeypatch.setattr(campaigns, "run_due", lambda session: calls.append(session) or 0)
        campaigns._sweep_once()
        assert len(calls) == 1

        def broken(session):
            raise RuntimeError("deadlock")

        monkeypatch.setattr(campaigns, "run_due", broken)
        rolled = []
        monkeypatch.setattr(db, "rollback", lambda: rolled.append(True))
        with pytest.raises(RuntimeError):
            campaigns._sweep_once()
        assert rolled == [True]

    def test_the_forever_loop_survives_a_failed_pass_and_stops_when_cancelled(self, monkeypatch, caplog):
        from app.services import jobs

        passes = []

        def failing_pass():
            passes.append(1)
            raise RuntimeError("bad pass")

        async def cancel(_seconds):
            raise asyncio.CancelledError

        monkeypatch.setattr(jobs, "tracked", lambda name, interval, fn: fn)
        monkeypatch.setattr(campaigns, "_sweep_once", failing_pass)
        monkeypatch.setattr(asyncio, "sleep", cancel)
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(campaigns.run_forever())
        assert passes == [1] and "Campaign sweep failed" in caplog.text


# ---------------------------------------------------------------- tracking


class TestTracking:
    @pytest.fixture()
    def sent_email(self, shop, db, admin_auth, email_account):  # noqa: F811
        opt_in(db, "CUS001", "email")
        created = draft(shop, admin_auth)
        assert launch_after_test(shop, admin_auth, created["id"], 1).status_code == 200
        campaigns.run_due(db)
        recipient = db.query(CampaignRecipient).filter_by(campaign_id=created["id"]).one()
        return created["id"], recipient

    def test_the_pixel_always_loads_and_counts_one_open(self, shop, db, sent_email):
        _, recipient = sent_email
        assert campaigns.record_open(db, recipient.token) is True
        assert campaigns.record_open(db, recipient.token) is False  # opened once
        assert campaigns.record_open(db, "0" * 32) is False
        assert fresh(db, recipient).status == "opened"
        short = shop.get("/api/c/o/short.gif")
        assert short.status_code == 200 and short.headers["content-type"] == "image/gif"
        assert short.headers["cache-control"] == "no-store, max-age=0"

    def test_the_pixel_loads_even_when_recording_fails(self, shop, monkeypatch):
        def broken(db, token):
            raise RuntimeError("database down")

        monkeypatch.setattr(campaigns, "record_open", broken)
        response = shop.get(f"/api/c/o/{'a' * 32}.gif")
        assert response.status_code == 200 and response.content.startswith(b"GIF89a")

    def test_a_click_counts_as_an_open_for_email(self, shop, db, sent_email):
        _, recipient = sent_email
        target = "http://localhost:3000/shop"
        response = shop.post("/api/campaigns/click", json={
            "token": recipient.token, "to": target, "s": campaigns._click_signature(recipient.token, target)})
        assert response.status_code == 200, response.text
        row = fresh(db, recipient)
        assert row.status == "clicked" and row.clicked_at is not None and row.opened_at == row.clicked_at
        # A pixel after the click changes nothing.
        assert campaigns.record_open(db, recipient.token) is False

    def test_a_signed_link_for_an_unknown_token_still_redirects(self, shop):
        target = "https://shop.example.com/sale"
        response = shop.post("/api/campaigns/click", json={
            "token": "unknown-token", "to": target, "s": campaigns._click_signature("unknown-token", target)})
        assert response.status_code == 200 and response.json()["data"]["url"] == target

    def test_a_forged_link_is_refused(self, shop):
        response = shop.post("/api/campaigns/click", json={"token": "abcd1234", "to": "https://evil.example.com",
                                                           "s": "deadbeef"})
        assert response.status_code == 422 and response.json()["error_code"] == "LINK_INVALID"


# --------------------------------------------------------------- analytics


class TestAnalyticsAndLists:
    def test_orders_with_the_campaign_coupon_are_attributed(self, shop, db, auth, admin_auth, coupon,
                                                            email_account):  # noqa: F811
        opt_in(db, "CUS001", "email")
        created = draft(shop, admin_auth, couponCode="SAVE10")
        launch_after_test(shop, admin_auth, created["id"], 1)
        campaigns.run_due(db)
        fill_bag(shop, auth, "PRD001")
        order = place(shop, auth, method="cod", coupon="SAVE10")["order"]
        detail = shop.get(f"/api/admin/campaigns/{created['id']}", headers=admin_auth).json()["data"]
        assert detail["analytics"]["revenue"] == {"orders": 1, "revenue": order["totals"]["total"]}
        assert detail["analytics"]["channels"]["email"]["clicked"] == 0  # attributed by coupon, not a click

    def test_a_draft_has_no_revenue(self, shop, db, admin_auth):
        created = draft(shop, admin_auth)
        row = db.get(MarketingCampaign, created["id"])
        assert campaigns.attributed_revenue(db, row) == {"orders": 0, "revenue": 0.0}
        assert shop.get(f"/api/admin/campaigns/{created['id']}", headers=admin_auth).json()["data"]["analytics"] is None

    def test_whatsapp_reports_reads_and_replies_but_not_clicks(self, shop, db, admin_auth, email_account,
                                                               sms_whatsapp):  # noqa: F811
        opt_in(db, "CUS001", "whatsapp")
        created = draft(shop, admin_auth, channels=("whatsapp",))
        assert launch_after_test(shop, admin_auth, created["id"], 1).status_code == 200
        campaigns.run_due(db)
        [row] = db.query(NotificationDelivery).filter_by(campaign_id=created["id"]).all()
        assert row.payload == {"template": "festive_edit", "language": "en", "variables": ["Asha"]}
        figures = shop.get(f"/api/admin/campaigns/{created['id']}", headers=admin_auth).json()["data"][
            "analytics"]["channels"]["whatsapp"]
        assert figures["sent"] == 1 and figures["opened"] == 0 and figures["replied"] == 0
        assert figures["clicked"] is None and figures["unsubscribed"] is None and figures["bounced"] is None
        assert figures["delivered"] == 0 and figures["rates"]["delivery"] == 0.0

    def test_the_list_filters_and_counts_what_was_sent(self, shop, db, admin_auth):
        opt_in(db, "CUS001", "in_app")
        sent = in_app_campaign(shop, admin_auth, name="Festive bell")
        shop.post(f"/api/admin/campaigns/{sent['id']}/launch", headers=admin_auth, json={"confirmMessages": 1})
        campaigns.run_due(db)
        draft(shop, admin_auth, name="Winter draft")
        everything = shop.get("/api/admin/campaigns", headers=admin_auth).json()["data"]
        assert everything["counts"] == {"sent": 1, "draft": 1} and everything["pagination"]["total"] == 2
        only_sent = shop.get("/api/admin/campaigns", headers=admin_auth, params={"status": "sent"}).json()["data"]
        assert [i["id"] for i in only_sent["items"]] == [sent["id"]] and only_sent["items"][0]["sent"] == 1  # the bell counts as delivered
        assert only_sent["counts"] == {"sent": 1, "draft": 1}  # tabs ignore the filter
        winter = [i for i in everything["items"] if i["name"] == "Winter draft"][0]
        by_id = shop.get("/api/admin/campaigns", headers=admin_auth, params={"q": str(winter["id"])}).json()["data"]
        assert [i["name"] for i in by_id["items"]] == ["Winter draft"] and "sent" not in by_id["items"][0]

    def test_the_list_box_takes_a_campaign_id_exactly(self, shop, db, admin_auth):
        """docs/id-lookup.md: the ID, exactly; a name, a prefix or junk finds nothing (and never a 500)."""
        first = draft(shop, admin_auth, name="Winter draft")
        longer_id = int(f"{first['id']}1")
        now = datetime.utcnow()
        db.add(MarketingCampaign(id=longer_id, name="Winter longer", channels=["in_app"], audience={}, content={},
                                 created_at=now, updated_at=now))
        db.flush()
        def ids(q):
            response = shop.get("/api/admin/campaigns", headers=admin_auth, params={"q": q})
            assert response.status_code == 200, response.text
            return [i["id"] for i in response.json()["data"]["items"]]
        assert ids(str(first["id"])) == [first["id"]]  # never the longer ID it is a prefix of
        assert ids(f"#{first['id']}") == [first["id"]]
        assert ids(str(longer_id)) == [longer_id]
        for text in ("Winter", "winter draft", "'; DROP TABLE marketing_campaigns; --", "a@b.com", "999999"):
            assert ids(text) == []

    def test_recipients_filter_by_channel_and_status(self, shop, db, admin_auth, email_account):  # noqa: F811
        opt_in(db, "CUS001", "email", "in_app")
        created = draft(shop, admin_auth, channels=("email", "in_app"))
        launch_after_test(shop, admin_auth, created["id"], 2)
        campaigns.run_due(db)
        url = f"/api/admin/campaigns/{created['id']}/recipients"
        bell = shop.get(url, headers=admin_auth, params={"channel": "in_app"}).json()["data"]
        assert [i["channel"] for i in bell["items"]] == ["in_app"] and bell["items"][0]["status"] == "delivered"
        assert bell["items"][0]["customer"] == {"id": "CUS001", "name": "Asha Rao"}
        delivered = shop.get(url, headers=admin_auth, params={"status": "delivered"}).json()["data"]
        assert delivered["pagination"]["total"] == 1
        none = shop.get(url, headers=admin_auth, params={"channel": "sms"}).json()["data"]
        assert none["items"] == [] and none["pagination"]["total"] == 0
        _ = types
