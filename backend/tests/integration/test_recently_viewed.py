"""
Recently viewed products: recording, reading, forgetting, the guest merge at
sign-in, the limit and the retention sweep — and that nobody can reach anyone
else's history.
"""

from __future__ import annotations

import calendar
from datetime import datetime, timedelta

import pytest

from app.core.config import settings

pytestmark = pytest.mark.integration


def view(client, auth, product_id, **extra):
    return client.post("/api/recently-viewed", headers=auth, json={"productId": product_id, **extra})


def history(client, auth, **params):
    response = client.get("/api/recently-viewed", headers=auth, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def ids(payload):
    return [item["productId"] for item in payload["data"]]


@pytest.fixture()
def many_products(db, catalogue):
    """Sixty more published products, for the limit."""
    from app.models import Product

    rows = [
        Product(id=f"PRD{100 + n}", slug=f"bulk-{n}", sku=f"DCZ-BK{n:04d}", name=f"Bulk {n}", brand="Bulk",
                category_id="CAT001", subcategory="tops", price=500 + n, original_price=500 + n, discount=0,
                stock=5, status="active", rating=3.0, review_count=0)
        for n in range(60)
    ]
    db.add_all(rows)
    db.flush()
    return rows


class TestRecording:
    def test_a_view_is_recorded_and_listed(self, client, auth, catalogue):
        assert view(client, auth, "PRD001").status_code == 202
        payload = history(client, auth)
        assert ids(payload) == ["PRD001"]
        entry = payload["data"][0]
        assert entry["product"]["name"] == "Cotton Kurta"
        assert entry["available"] is True and entry["availability"] == "in-stock"
        assert entry["viewCount"] == 1

    def test_newest_first(self, client, db, auth, customer, catalogue):
        from app.services import recently_viewed

        now = datetime.utcnow()
        recently_viewed.record(db, customer, "PRD001", now=now - timedelta(minutes=10))
        recently_viewed.record(db, customer, "PRD002", now=now - timedelta(minutes=5))
        recently_viewed.record(db, customer, "PRD003", now=now)
        assert ids(history(client, auth)) == ["PRD003", "PRD002", "PRD001"]

    def test_viewing_again_moves_it_to_the_front_without_a_duplicate(self, client, db, auth, customer, catalogue):
        from app.models import RecentlyViewedProduct
        from app.services import recently_viewed

        now = datetime.utcnow()
        recently_viewed.record(db, customer, "PRD001", now=now - timedelta(minutes=10))
        recently_viewed.record(db, customer, "PRD002", now=now - timedelta(minutes=5))
        recently_viewed.record(db, customer, "PRD001", now=now)
        assert ids(history(client, auth)) == ["PRD001", "PRD002"]
        rows = db.query(RecentlyViewedProduct).filter_by(customer_id=customer.id, product_id="PRD001").all()
        assert len(rows) == 1 and rows[0].view_count == 2

    def test_a_repeat_within_seconds_writes_nothing(self, client, auth, catalogue):
        assert view(client, auth, "PRD001").json()["data"]["recorded"] is True
        # A refresh, a re-render or React StrictMode's second effect.
        assert view(client, auth, "PRD001").json()["data"]["recorded"] is False

    def test_the_variant_is_remembered_only_if_real(self, client, db, auth, customer, catalogue):
        from app.models import ProductColor, ProductSize, RecentlyViewedProduct

        db.add_all([ProductColor(product_id="PRD001", name="Indigo", hex="#223", position=0),
                    ProductSize(product_id="PRD001", label="M", position=0)])
        db.flush()
        view(client, auth, "PRD001", color="Indigo", size="XXXL")
        row = db.query(RecentlyViewedProduct).filter_by(customer_id=customer.id).one()
        assert row.color == "Indigo" and row.size == ""

    @pytest.mark.parametrize("product_id", ["PRD004", "PRD999", "nope"])
    def test_drafts_and_unknown_products_are_refused(self, client, auth, catalogue, product_id):
        response = view(client, auth, product_id)
        assert response.status_code == 404
        assert response.json()["error_code"] == "PRODUCT_NOT_FOUND"
        assert ids(history(client, auth)) == []

    def test_a_guest_cannot_record(self, client, catalogue):
        assert client.post("/api/recently-viewed", json={"productId": "PRD001"}).status_code == 401

    def test_recording_is_rate_limited(self, client, auth, catalogue):
        codes = [view(client, auth, "PRD001").status_code for _ in range(121)]
        assert codes[-1] == 429


class TestTheLimit:
    def test_history_is_trimmed_to_the_limit(self, client, db, auth, customer, many_products, monkeypatch):
        from app.models import RecentlyViewedProduct
        from app.services import recently_viewed

        monkeypatch.setattr(settings, "RECENTLY_VIEWED_LIMIT", 20)
        start = datetime.utcnow() - timedelta(hours=2)
        for n, product in enumerate(many_products[:25]):
            recently_viewed.record(db, customer, product.id, now=start + timedelta(minutes=n))
        assert db.query(RecentlyViewedProduct).filter_by(customer_id=customer.id).count() == 20
        payload = history(client, auth, pageSize=50)
        # The five oldest fell off; the newest is first.
        assert ids(payload)[0] == many_products[24].id
        assert many_products[0].id not in ids(payload)
        assert payload["pagination"]["total"] == 20

    def test_pages(self, client, db, auth, customer, many_products):
        from app.services import recently_viewed

        start = datetime.utcnow() - timedelta(hours=1)
        for n, product in enumerate(many_products[:15]):
            recently_viewed.record(db, customer, product.id, now=start + timedelta(minutes=n))
        first = history(client, auth, page=1, pageSize=10)
        second = history(client, auth, page=2, pageSize=10)
        assert len(first["data"]) == 10 and len(second["data"]) == 5
        assert not set(ids(first)) & set(ids(second))
        assert first["pagination"]["total_pages"] == 2

    def test_a_long_history_reads_in_a_fixed_number_of_queries(self, client, db, auth, customer, many_products):
        """No N+1: the page size, not the history length, decides the work."""
        from sqlalchemy import event

        from app.services import recently_viewed

        start = datetime.utcnow() - timedelta(hours=1)
        for n, product in enumerate(many_products[:40]):
            recently_viewed.record(db, customer, product.id, now=start + timedelta(minutes=n))
        statements = []

        def count(*_args, **_kwargs):
            statements.append(1)

        engine = db.get_bind().engine
        event.listen(engine, "before_cursor_execute", count)
        try:
            history(client, auth, pageSize=40)
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert len(statements) <= 16, len(statements)


class TestReading:
    def test_unpublished_products_are_left_out(self, client, db, auth, customer, catalogue):
        from app.models import Product
        from app.services import recently_viewed

        recently_viewed.record(db, customer, "PRD002")
        db.get(Product, "PRD002").status = "draft"
        db.flush()
        assert ids(history(client, auth)) == []
        # Published again: back in the list, nothing lost.
        db.get(Product, "PRD002").status = "active"
        db.flush()
        assert ids(history(client, auth)) == ["PRD002"]

    def test_out_of_stock_is_shown_as_out_of_stock(self, client, db, auth, customer, catalogue):
        from app.services import recently_viewed

        recently_viewed.record(db, customer, "PRD003")
        entry = history(client, auth)["data"][0]
        assert entry["available"] is False and entry["availability"] == "out-of-stock"

    def test_a_deleted_product_disappears(self, client, db, auth, customer, catalogue):
        from app.models import Product, RecentlyViewedProduct
        from app.services import recently_viewed

        recently_viewed.record(db, customer, "PRD002")
        db.delete(db.get(Product, "PRD002"))
        db.flush()
        assert db.query(RecentlyViewedProduct).count() == 0
        assert ids(history(client, auth)) == []

    def test_exclude_keeps_the_current_product_out(self, client, db, auth, customer, catalogue):
        from app.services import recently_viewed

        recently_viewed.record(db, customer, "PRD001", now=datetime.utcnow() - timedelta(minutes=1))
        recently_viewed.record(db, customer, "PRD002")
        assert ids(history(client, auth, exclude="PRD002")) == ["PRD001"]

    def test_an_empty_history(self, client, auth, catalogue):
        payload = history(client, auth)
        assert payload["data"] == [] and payload["pagination"]["total"] == 0


class TestForgetting:
    def test_remove_one(self, client, db, auth, customer, catalogue):
        from app.models import AnalyticsEvent
        from app.services import recently_viewed

        recently_viewed.record(db, customer, "PRD001", now=datetime.utcnow() - timedelta(minutes=1))
        recently_viewed.record(db, customer, "PRD002")
        response = client.delete("/api/recently-viewed/PRD001", headers=auth)
        assert response.status_code == 200
        assert ids(history(client, auth)) == ["PRD002"]
        assert db.query(AnalyticsEvent).filter_by(event="recently_viewed_remove", product_id="PRD001").count() == 1

    def test_removing_what_is_not_there_is_a_404(self, client, auth, catalogue):
        assert client.delete("/api/recently-viewed/PRD001", headers=auth).status_code == 404

    def test_clear_all(self, client, db, auth, customer, catalogue):
        from app.services import recently_viewed

        recently_viewed.record(db, customer, "PRD001")
        recently_viewed.record(db, customer, "PRD002")
        response = client.delete("/api/recently-viewed", headers=auth)
        assert response.json()["data"]["removed"] == 2
        assert ids(history(client, auth)) == []


class TestOwnership:
    def test_one_customer_never_sees_anothers_history(self, client, db, auth, customer, other_customer, catalogue):
        from app.services import recently_viewed

        recently_viewed.record(db, other_customer, "PRD002")
        recently_viewed.record(db, customer, "PRD001")
        assert ids(history(client, auth)) == ["PRD001"]

    def test_removing_cannot_touch_anothers_rows(self, client, db, auth, customer, other_customer, catalogue):
        from app.models import RecentlyViewedProduct
        from app.services import recently_viewed

        recently_viewed.record(db, other_customer, "PRD002")
        assert client.delete("/api/recently-viewed/PRD002", headers=auth).status_code == 404
        client.delete("/api/recently-viewed", headers=auth)
        assert db.query(RecentlyViewedProduct).filter_by(customer_id=other_customer.id).count() == 1

    def test_an_admin_token_is_not_a_customer(self, client, admin_auth, catalogue):
        assert client.get("/api/recently-viewed", headers=admin_auth).status_code in (401, 403)

    def test_signed_out_is_refused(self, client):
        assert client.get("/api/recently-viewed").status_code == 401
        assert client.delete("/api/recently-viewed").status_code == 401


class TestGuestMerge:
    def test_a_guests_history_joins_the_account(self, client, auth, catalogue):
        now = datetime.utcnow()
        response = client.post("/api/recently-viewed/merge", headers=auth, json={"items": [
            {"productId": "PRD001", "viewedAt": (now - timedelta(minutes=3)).isoformat() + "Z"},
            # Milliseconds since the epoch, as `Date.now()` gives them.
            {"productId": "PRD002", "viewedAt": calendar.timegm((now - timedelta(minutes=1)).utctimetuple()) * 1000},
        ]})
        assert response.status_code == 200, response.text
        assert response.json()["data"] == {"merged": 2, "skipped": 0}
        assert ids(history(client, auth)) == ["PRD002", "PRD001"]

    def test_duplicates_collapse_to_the_newest(self, client, auth, catalogue):
        now = datetime.utcnow()
        client.post("/api/recently-viewed/merge", headers=auth, json={"items": [
            {"productId": "PRD001", "viewedAt": (now - timedelta(minutes=9)).isoformat()},
            {"productId": "PRD001", "viewedAt": (now - timedelta(minutes=1)).isoformat()},
            {"productId": "PRD002", "viewedAt": (now - timedelta(minutes=5)).isoformat()},
        ]})
        assert ids(history(client, auth)) == ["PRD001", "PRD002"]

    def test_an_older_guest_view_never_overwrites_a_newer_one(self, client, db, auth, customer, catalogue):
        from app.models import RecentlyViewedProduct
        from app.services import recently_viewed

        newer = datetime.utcnow() - timedelta(minutes=1)
        recently_viewed.record(db, customer, "PRD001", now=newer)
        client.post("/api/recently-viewed/merge", headers=auth, json={"items": [
            {"productId": "PRD001", "viewedAt": (newer - timedelta(days=2)).isoformat()},
        ]})
        row = db.query(RecentlyViewedProduct).filter_by(customer_id=customer.id, product_id="PRD001").one()
        assert abs((row.viewed_at - newer).total_seconds()) < 1
        assert row.view_count == 1

    def test_drafts_and_unknown_ids_are_skipped(self, client, auth, catalogue):
        response = client.post("/api/recently-viewed/merge", headers=auth, json={"items": [
            {"productId": "PRD004"}, {"productId": "PRD999"}, {"productId": "PRD001"},
        ]})
        assert response.json()["data"] == {"merged": 1, "skipped": 2}

    def test_an_unknown_time_counts_as_oldest(self, client, db, auth, customer, catalogue):
        """A guest view recorded before the browser kept times arrives as 0."""
        from app.services import recently_viewed

        recently_viewed.record(db, customer, "PRD002")
        client.post("/api/recently-viewed/merge", headers=auth, json={"items": [{"productId": "PRD001",
                                                                                 "viewedAt": 0}]})
        assert ids(history(client, auth)) == ["PRD002", "PRD001"]

    def test_a_timestamp_from_the_future_counts_as_now(self, client, db, auth, customer, catalogue):
        from app.models import RecentlyViewedProduct

        client.post("/api/recently-viewed/merge", headers=auth, json={"items": [
            {"productId": "PRD001", "viewedAt": "2999-01-01T00:00:00Z"}]})
        row = db.query(RecentlyViewedProduct).filter_by(customer_id=customer.id).one()
        assert row.viewed_at <= datetime.utcnow() + timedelta(seconds=5)

    def test_the_merge_respects_the_limit(self, client, db, auth, customer, many_products, monkeypatch):
        from app.models import RecentlyViewedProduct

        monkeypatch.setattr(settings, "RECENTLY_VIEWED_LIMIT", 10)
        now = datetime.utcnow()
        client.post("/api/recently-viewed/merge", headers=auth, json={"items": [
            {"productId": p.id, "viewedAt": (now - timedelta(minutes=n)).isoformat()}
            for n, p in enumerate(many_products[:30])]})
        assert db.query(RecentlyViewedProduct).filter_by(customer_id=customer.id).count() == 10

    def test_too_many_items_are_refused(self, client, auth, catalogue):
        response = client.post("/api/recently-viewed/merge", headers=auth,
                               json={"items": [{"productId": "PRD001"}] * 51})
        assert response.status_code == 422

    def test_merging_twice_changes_nothing(self, client, db, auth, customer, catalogue):
        from app.models import RecentlyViewedProduct

        body = {"items": [{"productId": "PRD001", "viewedAt": datetime.utcnow().isoformat()}]}
        client.post("/api/recently-viewed/merge", headers=auth, json=body)
        client.post("/api/recently-viewed/merge", headers=auth, json=body)
        assert db.query(RecentlyViewedProduct).filter_by(customer_id=customer.id).count() == 1


class TestRetention:
    def test_the_sweep_forgets_old_history(self, db, customer, catalogue, monkeypatch):
        from app.models import RecentlyViewedProduct
        from app.services import discovery_jobs, recently_viewed

        monkeypatch.setattr(settings, "RECENTLY_VIEWED_RETENTION_DAYS", 30)
        recently_viewed.record(db, customer, "PRD001", now=datetime.utcnow() - timedelta(days=45))
        recently_viewed.record(db, customer, "PRD002", now=datetime.utcnow() - timedelta(days=2))
        assert discovery_jobs.sweep(db) == {"recentlyViewedRemoved": 1}
        assert [r.product_id for r in db.query(RecentlyViewedProduct).all()] == ["PRD002"]


class TestPortal:
    def test_summary_needs_analytics(self, client, admin_auth, editor, catalogue):
        assert client.get("/api/admin/discovery/summary", headers=admin_auth).status_code == 200
        response = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"})
        editor_auth = {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}
        assert client.get("/api/admin/discovery/summary", headers=editor_auth).status_code == 403

    def test_a_customers_history_for_the_portal(self, client, db, admin_auth, customer, catalogue):
        from app.services import recently_viewed

        recently_viewed.record(db, customer, "PRD001")
        data = client.get(f"/api/admin/customers/{customer.id}/discovery", headers=admin_auth).json()["data"]
        assert [r["productId"] for r in data["recentlyViewed"]] == ["PRD001"]
        assert data["savedForLater"] == []

    def test_a_customer_token_cannot_read_the_portal_view(self, client, auth, customer):
        assert client.get(f"/api/admin/customers/{customer.id}/discovery", headers=auth).status_code in (401, 403)
