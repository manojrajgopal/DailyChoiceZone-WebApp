"""
Advanced analytics — every figure from the order records or recorded events,
never from the browser — and system health: the public probes say only
whether the server can take traffic; the detail is for administrators, and
carries no secrets.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core import rate_limit
from app.models import AnalyticsEvent, HealthSnapshot, JobHeartbeat, Notification
from app.services import health, insights
from tests.integration.wallet_helpers import fill_bag, mailbox, place  # noqa: F401

pytestmark = pytest.mark.integration

VISITOR = "visitor-abcdef123456"


@pytest.fixture(autouse=True)
def _fresh():
    rate_limit.reset()
    insights.clear_cache()
    yield
    rate_limit.reset()


@pytest.fixture()
def shop(client, catalogue, customer, settings_documents, admin_auth, auth):
    return client


def event(client, name, product=None, visitor=VISITOR, headers=None, agent="Mozilla/5.0 (iPhone) Mobile"):
    return client.post("/api/analytics/events", headers={"User-Agent": agent, **(headers or {})},
                       json={"event": name, "visitorId": visitor, "productId": product,
                             "referrer": "https://www.google.com/search"})


class TestEvents:
    def test_events_are_checked_and_counted_once(self, shop, db):
        assert event(shop, "visit").json()["data"]["recorded"] is True
        assert event(shop, "visit").json()["data"]["recorded"] is False  # once a day per visitor
        assert event(shop, "purchase").json()["data"]["recorded"] is False  # not something a browser may say
        assert event(shop, "product_view", product="PRD004").json()["data"]["recorded"] is False  # a draft
        assert event(shop, "product_view", product="PRD001").json()["data"]["recorded"] is True
        assert event(shop, "visit", visitor="x").status_code == 202  # malformed id: ignored
        assert event(shop, "visit", visitor="other-visitor-0001", agent="Googlebot/2.1").json()["data"]["recorded"] is False
        visit = db.query(AnalyticsEvent).filter_by(event="visit").one()
        assert visit.source == "google.com" and visit.device == "mobile"
        assert visit.visitor_id != VISITOR  # stored hashed

    def test_events_are_rate_limited(self, shop):
        for index in range(120):
            event(shop, "visit", visitor=f"visitor-{index:012d}")
        assert event(shop, "visit", visitor="visitor-overflow-1").status_code == 429


class TestReports:
    def test_sales_come_from_orders_and_compare_with_the_period_before(self, shop, auth, admin_auth, db):
        from app.models import Order

        fill_bag(shop, auth, "PRD001", 2)
        place(shop, auth)
        fill_bag(shop, auth, "PRD002", 1)
        earlier = place(shop, auth)["order"]
        # The second order belongs to the previous 30 days.
        db.get(Order, earlier["id"]).placed_at = datetime.utcnow() - timedelta(days=40)
        db.flush()
        report = shop.get("/api/admin/analytics/sales?range=30d", headers=admin_auth).json()["data"]
        assert report["metrics"]["revenue"]["value"] == 2000
        assert report["metrics"]["orders"]["value"] == 1
        assert report["metrics"]["revenue"]["previous"] == 2000
        assert report["metrics"]["revenue"]["delta"] == 0
        assert sum(p["revenue"] for p in report["series"]) == 2000
        assert report["breakdowns"]["category"][0]["label"] == "Women"
        assert report["breakdowns"]["state"][0]["label"] == "Karnataka"

    def test_cancelled_orders_are_not_revenue(self, shop, auth, admin_auth):
        fill_bag(shop, auth, "PRD001", 1)
        order = place(shop, auth, method="cod")["order"]
        shop.post(f"/api/orders/{order['id']}/cancel", headers=auth, json={"reason": "No"})
        report = shop.get("/api/admin/analytics/sales?range=7d", headers=admin_auth).json()["data"]
        assert report["metrics"]["revenue"]["value"] == 0
        assert report["metrics"]["cancelled"]["value"] == 1

    def test_the_funnel_counts_each_stage(self, shop, auth, admin_auth):
        event(shop, "visit")
        event(shop, "product_view", product="PRD001")
        fill_bag(shop, auth, "PRD001", 1)
        event(shop, "checkout_start", headers=auth)
        place(shop, auth)
        stages = {s["key"]: s["count"] for s in
                  shop.get("/api/admin/analytics/funnel?range=today", headers=admin_auth).json()["data"]["stages"]}
        assert stages == {"visitors": 1, "productViews": 1, "addToCart": 1, "checkout": 1, "paymentAttempt": 1,
                          "purchase": 1}

    def test_customers_products_and_marketing(self, shop, auth, admin_auth):
        event(shop, "product_view", product="PRD001")
        event(shop, "product_view", product="PRD002")
        fill_bag(shop, auth, "PRD001", 3)
        place(shop, auth)
        customers = shop.get("/api/admin/analytics/customers?range=30d", headers=admin_auth).json()["data"]
        assert customers["metrics"]["buyers"]["value"] == 1 and customers["metrics"]["newBuyers"]["value"] == 1
        products = shop.get("/api/admin/analytics/products?range=30d", headers=admin_auth).json()["data"]
        top = products["topByRevenue"][0]
        assert top["productId"] == "PRD001" and top["units"] == 3 and top["conversion"] == 100.0
        assert products["viewedNotBought"][0]["productId"] == "PRD002"
        marketing = shop.get("/api/admin/analytics/marketing?range=30d", headers=admin_auth).json()["data"]
        assert marketing["trafficSources"] == []  # no visits recorded, none invented

    def test_custom_ranges_are_validated_and_csv_exports(self, shop, admin_auth):
        bad = shop.get("/api/admin/analytics/sales?range=custom&start=2026-05-10&end=2026-05-01", headers=admin_auth)
        assert bad.status_code == 422
        csv = shop.get("/api/admin/analytics/export/sales?range=custom&start=2026-05-01&end=2026-05-03",
                       headers=admin_auth)
        assert csv.status_code == 200 and csv.text.splitlines()[0].startswith("period,revenue")
        assert len(csv.text.strip().splitlines()) == 4  # a header and three days, empty ones included

    def test_analytics_needs_its_permission(self, shop, auth, editor, client):
        assert shop.get("/api/admin/analytics/sales", headers=auth).status_code == 403
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}).json()
        headers = {"Authorization": f"Bearer {token['data']['token']['accessToken']}"}
        assert shop.get("/api/admin/analytics/sales", headers=headers).status_code == 403


class TestHealth:
    def test_the_probes(self, client, db):
        assert client.get("/health/live").json()["data"]["status"] == "alive"
        ready = client.get("/health/ready")
        assert ready.status_code == 200 and ready.json()["data"] == {"status": "ready", "database": "healthy",
                                                                        "schema": ready.json()["data"]["schema"]}

    def test_the_detail_is_for_administrators_and_shows_no_secrets(self, client, db, admin_auth, auth):
        from app.core.config import settings

        assert client.get("/api/admin/health", headers=auth).status_code == 403
        assert client.get("/api/admin/health").status_code == 401
        body = client.get("/api/admin/health", headers=admin_auth)
        assert body.status_code == 200
        data = body.json()["data"]
        assert set(data["checks"]) == {"database", "migrations", "payments", "email", "jobs", "storage", "disk",
                                       "application", "backups", "messaging"}
        assert data["status"] in ("healthy", "degraded", "unhealthy", "unknown")
        text = body.text
        for secret in (settings.JWT_SECRET_KEY, settings.DATABASE_PASSWORD if hasattr(settings, "DATABASE_PASSWORD") else "",
                       settings.RAZOR_KEY_SECRET, settings.AWS_SECRET_ACCESS_KEY, settings.DATABASE_HOST
                       if hasattr(settings, "DATABASE_HOST") else ""):
            if secret and len(secret) > 3:
                assert secret not in text

    def test_job_heartbeats_decide_the_jobs_status(self, db):
        now = datetime.utcnow()
        db.add(JobHeartbeat(name="alerts", interval_seconds=120, last_started_at=now, last_success_at=now,
                            runs=5, failures=0, consecutive_failures=0, last_error="", last_duration_ms=10))
        db.add(JobHeartbeat(name="loyalty", interval_seconds=900, last_started_at=now,
                            last_success_at=now - timedelta(hours=3), runs=5, failures=0, consecutive_failures=0,
                            last_error="", last_duration_ms=10))
        db.add(JobHeartbeat(name="cart_recovery", interval_seconds=300, last_started_at=now, last_success_at=now,
                            runs=9, failures=4, consecutive_failures=3, last_error="OperationalError: gone",
                            last_duration_ms=10))
        db.flush()
        jobs = {j["name"]: j["status"] for j in health.check_jobs(db, now)["jobs"]}
        assert jobs["alerts"] == "healthy" and jobs["loyalty"] == "degraded"
        assert jobs["cart_recovery"] == "unhealthy" and jobs["referrals"] == "unknown"

    def test_a_tracked_job_records_success_and_failure(self, db):
        from app.services import jobs

        jobs.tracked("alerts", 120, lambda: None)()
        with pytest.raises(RuntimeError):
            jobs.tracked("alerts", 120, lambda: (_ for _ in ()).throw(RuntimeError("boom")))()
        db.expire_all()
        beat = db.get(JobHeartbeat, "alerts")
        assert beat.runs == 2 and beat.failures == 1 and beat.consecutive_failures == 1
        assert beat.last_error == "RuntimeError: boom"

    def test_the_team_hears_once_when_it_breaks_and_when_it_recovers(self, db, admin, mailbox):  # noqa: F811
        broken = {"status": "unhealthy", "checkedAt": datetime.utcnow(), "durationMs": 3, "deep": False,
                  "checks": {"database": {"status": "unhealthy", "message": "The database isn't answering.",
                                          "label": "Database"}}}
        health.record_and_alert(db, broken)
        health.record_and_alert(db, {**broken, "checkedAt": datetime.utcnow()})
        health.record_and_alert(db, {**broken, "status": "healthy", "checkedAt": datetime.utcnow()})
        titles = [n.title for n in db.query(Notification).filter_by(kind="health").order_by(Notification.created_at)]
        # Both may share a second (and the ids are random), so compare without order: one of each, once.
        assert sorted(titles) == ["System health: recovered", "System health: something is broken"]
        assert db.query(HealthSnapshot).count() == 3

    def test_a_manual_run_is_kept_in_the_history(self, client, db, admin_auth, monkeypatch):
        monkeypatch.setattr(health, "_ping_razorpay", lambda: (True, 5))
        response = client.post("/api/admin/health/run", headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["deep"] is True
        assert len(response.json()["data"]["history"]) == 1
