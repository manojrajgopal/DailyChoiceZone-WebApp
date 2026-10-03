"""
Customer metrics: every figure computed from its source tables, the dirty
hook, the refresh passes, RFM settings changes, the `segments` job, and a
2,000-customer batch.
"""

from __future__ import annotations

import time
from datetime import timedelta

import pytest
from sqlalchemy import insert, select

from app.models import (
    AnalyticsEvent,
    CampaignRecipient,
    CartItem,
    CartRecovery,
    ChannelPreference,
    Customer,
    CouponUsage,
    CustomerMembership,
    LoyaltyAccount,
    LoyaltyLot,
    LoyaltyTransaction,
    MarketingCampaign,
    MembershipPlan,
    Order,
    OrderTender,
    Referral,
    ReturnRequest,
    StoreCreditAccount,
    WishlistItem,
)
from app.models.segments import CustomerMetrics, Segment, SegmentMember
from app.services.segments import jobs, metrics, service
from tests.integration.segments_helpers import now, order, person, refund

pytestmark = pytest.mark.integration


def settle(db) -> None:
    """Backdate every mark: a row marked in the same second as a refresh (safely) stays dirty."""
    db.execute(CustomerMetrics.__table__.update().values(marked_at=now() - timedelta(seconds=5)))


def row(db, cid) -> CustomerMetrics:
    db.expire_all()
    return db.get(CustomerMetrics, cid)


class TestOrdersAndMoney:
    def test_counts_spend_dates_and_rfm(self, db, catalogue):
        person(db, "CUS101")
        order(db, "CUS101", 1000, days_ago=100)
        order(db, "CUS101", 2500.50, days_ago=10)
        order(db, "CUS101", 9999, days_ago=3, status="cancelled")
        order(db, "CUS101", 700, days_ago=50, status="returned")
        settle(db)
        metrics.refresh(db, ["CUS101"])
        m = row(db, "CUS101")
        assert (m.total_orders, m.kept_orders, m.cancelled_orders, m.returned_orders) == (3, 2, 1, 1)
        assert m.total_spend == 350050  # paise; cancelled and returned excluded
        assert m.average_order_value == 175025
        assert (now() - m.last_order_at).days == 10 and (now() - m.first_order_at).days == 100
        assert (m.recency_score, m.frequency_score, m.monetary_score) == (5, 2, 3)
        assert m.rfm_label == "potential"
        assert m.dirty is False and m.refreshed_at is not None

    def test_completed_refunds_reduce_spend_and_count_refunded_orders(self, db, catalogue):
        person(db, "CUS102")
        kept = order(db, "CUS102", 2000)
        refund(db, kept, 50000)  # ₹500 partial refund
        other = order(db, "CUS102", 1000)
        refund(db, other, 10000, status="requested")  # not completed: ignored
        metrics.refresh(db, ["CUS102"])
        m = row(db, "CUS102")
        assert m.total_spend == 250000 and m.refunded_orders == 1

    def test_spend_never_goes_negative(self, db, catalogue):
        person(db, "CUS103")
        refund(db, order(db, "CUS103", 100), 99999)
        metrics.refresh(db, ["CUS103"])
        assert row(db, "CUS103").total_spend == 0

    def test_a_customer_with_no_orders(self, db):
        person(db, "CUS104")
        metrics.refresh(db, ["CUS104"])
        m = row(db, "CUS104")
        assert (m.total_orders, m.total_spend, m.rfm_label, m.recency_score) == (0, 0, "no-orders", 0)
        assert m.membership_status == "none" and m.purchased_category_ids == []


class TestEverythingElse:
    def test_every_source(self, db, catalogue, coupon):
        person(db, "CUS201", city="Bengaluru")
        person(db, "CUS202")
        first = order(db, "CUS201", 1200, days_ago=20, product="PRD001", coupon="SAVE10")
        order(db, "CUS201", 3000, days_ago=4, product="PRD003")
        t = now()
        db.add(CouponUsage(coupon_id=coupon.id, customer_id="CUS201", order_id=first.id, discount_amount=10, used_at=t))
        db.add_all([WishlistItem(customer_id="CUS201", product_id="PRD001"),
                    WishlistItem(customer_id="CUS201", product_id="PRD002"),
                    CartItem(customer_id="CUS201", product_id="PRD002", quantity=1)])
        db.add_all([CartRecovery(customer_id="CUS201", status="abandoned", started_at=t, last_activity_at=t,
                                 abandoned_at=t, created_at=t, updated_at=t),
                    CartRecovery(customer_id="CUS201", status="recovered", started_at=t, last_activity_at=t,
                                 abandoned_at=t, created_at=t, updated_at=t)])
        db.add(ReturnRequest(id="RTS001", order_id=first.id, customer_id="CUS201", kind="return", status="requested",
                             reason="Changed my mind", created_at=t, updated_at=t))
        db.add(ReturnRequest(id="RTS002", order_id=first.id, customer_id="CUS201", kind="return", status="rejected",
                             reason="Changed my mind", created_at=t, updated_at=t))
        db.add(MembershipPlan(id="MPL901", name="Gold", duration_months=12, price=999, created_at=t, updated_at=t))
        db.flush()
        db.add(CustomerMembership(id="MEM901", customer_id="CUS201", plan_id="MPL901", plan_name="Gold",
                                  duration_months=12, status="active", amount=99900, starts_at=t - timedelta(days=1),
                                  ends_at=t + timedelta(days=300), created_at=t, updated_at=t))
        db.add(CustomerMembership(id="MEM902", customer_id="CUS202", plan_id="MPL901", plan_name="Gold",
                                  duration_months=12, status="active", amount=99900, starts_at=t - timedelta(days=400),
                                  ends_at=t - timedelta(days=30), created_at=t - timedelta(days=400), updated_at=t))
        txn = LoyaltyTransaction(customer_id="CUS201", kind="earned", points=150, balance_after=150, created_at=t)
        db.add(txn)
        db.flush()
        db.add_all([
            LoyaltyLot(customer_id="CUS201", transaction_id=txn.id, points=100, remaining=100, available_at=t,
                       released=True, created_at=t),
            LoyaltyLot(customer_id="CUS201", transaction_id=txn.id, points=50, remaining=50, available_at=t,
                       released=False, created_at=t),  # pending: not spendable
            LoyaltyLot(customer_id="CUS201", transaction_id=txn.id, points=30, remaining=30, available_at=t,
                       released=True, expires_at=t - timedelta(days=1), created_at=t),  # expired
            LoyaltyAccount(customer_id="CUS201", debt=20, created_at=t, updated_at=t),
            StoreCreditAccount(customer_id="CUS201", balance=45000, created_at=t, updated_at=t),
        ])
        db.add(OrderTender(order_id=first.id, kind="gift_card", tender_key="gift_card:1", amount=30000,
                           reversed_amount=5000, created_at=t, updated_at=t))
        db.add_all([Referral(referrer_id="CUS201", referee_id="CUS202", code="ABC", status="rewarded", created_at=t,
                             updated_at=t)])
        campaign = MarketingCampaign(name="C", channels=["email"], audience={}, content={}, created_at=t, updated_at=t)
        db.add(campaign)
        db.flush()
        db.add(CampaignRecipient(campaign_id=campaign.id, customer_id="CUS201", channel="email", token="t" * 32,
                                 opened_at=t - timedelta(days=2), clicked_at=t - timedelta(days=1), created_at=t))
        db.add_all([ChannelPreference(customer_id="CUS201", channel="email", category="marketing", enabled=False,
                                      updated_at=t),
                    ChannelPreference(customer_id="CUS201", channel="sms", category="marketing", enabled=True,
                                      updated_at=t)])
        db.add_all([AnalyticsEvent(occurred_at=t, event="product_view", customer_id="CUS201", product_id=p)
                    for p in ("PRD001", "PRD002", "PRD003", "PRD003")])
        db.add(AnalyticsEvent(occurred_at=t - timedelta(days=200), event="product_view", customer_id="CUS201",
                              product_id="PRD004"))  # too old
        db.flush()
        metrics.refresh(db, ["CUS201", "CUS202"])
        m = row(db, "CUS201")
        assert (m.coupon_uses, m.wishlist_items, m.has_active_cart) == (1, 2, True)
        assert (m.abandoned_carts, m.has_abandoned_cart, m.return_requests) == (2, True, 1)
        assert (m.membership_status, m.membership_plan_id) == ("active", "MPL901")
        assert m.points_balance == 80 and m.store_credit_balance == 45000
        assert (m.gift_card_orders, m.gift_card_spend) == (1, 25000)
        assert (m.referral_count, m.was_referred) == (1, False)
        assert (m.campaigns_received, m.campaign_opens, m.campaign_clicks) == (1, 1, 1)
        assert (now() - m.last_engaged_at).days == 1
        assert (m.email_opt_in, m.sms_opt_in, m.whatsapp_opt_in) == (False, True, False)
        assert (m.products_viewed_90d, m.categories_viewed_90d) == (3, 2)
        assert sorted(m.purchased_category_ids) == ["CAT001", "CAT002"]
        assert (m.city, m.state, m.pincode) == ("Bengaluru", "Karnataka", "560001")
        other = row(db, "CUS202")
        assert other.membership_status == "expired" and other.was_referred is True
        assert other.email_opt_in is True  # the channel's default

    def test_the_address_falls_back_to_the_last_order(self, db, catalogue):
        person(db, "CUS203")
        order(db, "CUS203", 500)
        metrics.refresh(db, ["CUS203"])
        assert row(db, "CUS203").city == "Mysuru"

    def test_unknown_ids_are_skipped(self, db):
        assert metrics.refresh(db, ["CUS999", ""]) == 0


class TestDirtyHook:
    def test_new_customers_and_order_changes_mark_the_row(self, db, catalogue):
        person(db, "CUS301")
        assert row(db, "CUS301").dirty is True
        settle(db)
        metrics.refresh(db, ["CUS301"])
        assert row(db, "CUS301").dirty is False
        placed = order(db, "CUS301", 900)
        assert row(db, "CUS301").dirty is True
        metrics.refresh(db, ["CUS301"])
        placed = db.get(Order, placed.id)
        placed.status = "cancelled"
        db.flush()
        assert row(db, "CUS301").dirty is True

    def test_a_mark_during_a_refresh_survives_it(self, db):
        person(db, "CUS302")
        later = now() + timedelta(seconds=30)
        db.execute(CustomerMetrics.__table__.update().where(CustomerMetrics.customer_id == "CUS302")
                   .values(marked_at=later, dirty=True))
        metrics.refresh(db, ["CUS302"])
        assert row(db, "CUS302").dirty is True

    def test_refresh_dirty_and_rows_for_customers_without_one(self, db):
        person(db, "CUS303")
        db.execute(CustomerMetrics.__table__.delete().where(CustomerMetrics.customer_id == "CUS303"))
        assert row(db, "CUS303") is None
        assert metrics.ensure_rows(db) >= 1 and row(db, "CUS303").dirty is True
        settle(db)
        refreshed = metrics.refresh_dirty(db)
        assert "CUS303" in refreshed and row(db, "CUS303").dirty is False

    def test_wishlist_changes_mark_the_row(self, db, catalogue):
        person(db, "CUS304")
        metrics.refresh(db, ["CUS304"])
        db.add(WishlistItem(customer_id="CUS304", product_id="PRD001"))
        db.flush()
        assert row(db, "CUS304").dirty is True


class TestSettingsAndRescore:
    def test_changing_bands_rescores_everyone(self, db, admin, catalogue):
        person(db, "CUS401")
        order(db, "CUS401", 500, days_ago=20)
        metrics.refresh(db, ["CUS401"])
        assert row(db, "CUS401").recency_score == 5
        conf = {**metrics.DEFAULT_SETTINGS, "recencyDays": [5, 10, 15, 19]}
        metrics.save_settings(db, admin, conf)
        assert row(db, "CUS401").recency_score == 1
        assert row(db, "CUS401").rfm_label == "lost"
        assert metrics.settings(db)["recencyDays"] == [5, 10, 15, 19]

    def test_a_broken_saved_document_falls_back_to_the_defaults(self, db):
        from app.models import SettingDocument

        db.add(SettingDocument(key="segmentation", value={"recencyDays": "nonsense"}))
        db.flush()
        assert metrics.settings(db)["recencyDays"] == [30, 60, 90, 180]


class TestJob:
    def test_sweep_full_then_dirty(self, db, catalogue):
        person(db, "CUS501")
        order(db, "CUS501", 30000, days_ago=2)
        db.execute(CustomerMetrics.__table__.delete())
        first = jobs.sweep(db)
        assert first["full"] is True and first["refreshed"] >= 1 and first["seeded"] == len(service.DEFAULTS)
        high = db.execute(select(Segment).where(Segment.slug == "high-value")).scalar_one()
        assert db.get(SegmentMember, (high.id, "CUS501")) is not None
        # A change: only that customer is refreshed, and memberships follow.
        settle(db)
        order(db, "CUS501", 1, days_ago=1, status="cancelled")
        second = jobs.sweep(db)
        assert second["full"] is False and second["refreshed"] == 1 and second["seeded"] == 0
        settle(db)
        jobs.sweep(db)
        assert jobs.sweep(db)["refreshed"] == 0

    def test_full_refresh_is_due_after_refresh_hours(self, db):
        person(db, "CUS502")
        metrics.refresh(db, ["CUS502"])
        assert metrics.full_refresh_due(db) is False
        db.execute(CustomerMetrics.__table__.update().values(refreshed_at=now() - timedelta(hours=7)))
        assert metrics.full_refresh_due(db) is True

    def test_interval(self):
        assert jobs.interval() >= 60


class TestScale:
    def test_two_thousand_customers(self, db, catalogue):
        t = now()
        db.execute(insert(Customer), [
            {"id": f"CUZ{i:05d}", "email": f"bulk{i}@example.com", "password_hash": "x", "first_name": "Bulk",
             "last_name": str(i), "phone": "", "status": "active", "joined_at": t - timedelta(days=i % 400)}
            for i in range(2000)])
        db.execute(insert(Order), [
            {"id": f"ORZ{i:05d}", "order_number": f"BULK{i:06d}", "customer_id": f"CUZ{i:05d}", "customer_name": "B",
             "customer_email": "b@example.com", "placed_at": t - timedelta(days=i % 300), "status": "delivered",
             "payment_status": "paid", "total": 100 + (i % 50) * 100, "subtotal": 0}
            for i in range(0, 2000, 2)])
        clock = time.monotonic()
        result = service.refresh_everything(db)
        elapsed = time.monotonic() - clock
        assert result["refreshed"] >= 2000
        assert db.execute(select(CustomerMetrics).where(CustomerMetrics.customer_id == "CUZ00000")
                          ).scalar_one().total_orders == 1
        one_time = db.execute(select(Segment).where(Segment.slug == "one-time-buyers")).scalar_one()
        assert one_time.member_count == 1000
        assert elapsed < 90, elapsed
