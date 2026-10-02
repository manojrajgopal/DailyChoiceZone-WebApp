"""
Locked reads must see the row as it is now, not as this session first saw it.

SQLAlchemy returns an object it already holds from a `SELECT ... FOR UPDATE`
without overwriting it, unless the query asks for `populate_existing`. So a
check made under the lock can read data that another transaction changed and
committed meanwhile: the lock is real, but the numbers are stale. `products`
documents this and refreshes; the two below did not, and these tests reproduce
the exact interleaving without threads, so they can't pass by luck of timing:

1. this session reads the record,
2. another connection changes it and commits,
3. this session takes the lock and decides.

They use committed data on their own connections and delete it afterwards.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app.core.errors import ConflictError

pytestmark = pytest.mark.integration


@pytest.fixture()
def Session(engine):
    return sessionmaker(bind=engine)


def _sql(engine, statement, **params):
    with engine.begin() as connection:
        connection.execute(text(statement), params)


class TestCouponLastUse:
    @pytest.fixture()
    def coupon(self, engine, Session):
        from app.models import Coupon

        setup = Session()
        setup.add(Coupon(id="CPNLOCK", code="LOCKED", type="flat", value=10, min_subtotal=0, active=True,
                         starts_at=datetime.utcnow() - timedelta(days=1), usage_limit=1, usage_count=0))
        setup.commit()
        setup.close()
        yield
        _sql(engine, "DELETE FROM coupons WHERE id = 'CPNLOCK'")

    def test_a_use_taken_by_someone_else_meanwhile_is_seen_under_the_lock(self, engine, Session, coupon):
        from app.services import coupons

        mine = Session()
        try:
            # 1. Checkout prices the discount: the coupon is now in this session.
            assert coupons.validate_coupon(mine, "LOCKED", 100_000, customer_id=None)["valid"]
            # 2. Another shopper's checkout takes the last use and commits.
            _sql(engine, "UPDATE coupons SET usage_count = 1 WHERE id = 'CPNLOCK'")
            # 3. This checkout records its use: it must see the use is gone.
            with pytest.raises(ConflictError) as caught:
                coupons.record_usage(mine, "LOCKED", "CUS-LOCK", "ORD-LOCK", 1000)
            assert caught.value.error_code == "COUPON_EXHAUSTED"
        finally:
            mine.rollback()
            mine.close()

    def test_the_count_is_never_written_back_lower(self, engine, Session, coupon):
        """The lost update: a stale copy of 0, plus one, written over another shopper's 1."""
        from app.models import Coupon
        from app.services import coupons

        _sql(engine, "UPDATE coupons SET usage_limit = 5 WHERE id = 'CPNLOCK'")
        mine = Session()
        try:
            coupons.validate_coupon(mine, "LOCKED", 100_000, customer_id=None)
            _sql(engine, "UPDATE coupons SET usage_count = 3 WHERE id = 'CPNLOCK'")
            coupons.record_usage(mine, "LOCKED", "CUS-LOCK", "ORD-LOCK", 1000)
            assert mine.get(Coupon, "CPNLOCK").usage_count == 4
        finally:
            mine.rollback()
            mine.close()


class TestMembershipSettledElsewhere:
    @pytest.fixture()
    def pending(self, engine, Session):
        from app.core.security import hash_password
        from app.models import Customer, CustomerMembership, MembershipPlan

        now = datetime(2026, 1, 1)
        setup = Session()
        setup.add(Customer(id="CUSLOCK", email="locking@example.com", password_hash=hash_password("x1234567"),
                           first_name="L", status="active", joined_at=now))
        setup.add(MembershipPlan(id="MBPLOCK", name="Gold", duration_months=12, price=999, created_at=now,
                                 updated_at=now))
        setup.flush()
        setup.add(CustomerMembership(id="MEMLOCK", customer_id="CUSLOCK", plan_id="MBPLOCK", plan_name="Gold",
                                     duration_months=12, amount=99_900, status="pending", created_at=now,
                                     updated_at=now))
        setup.commit()
        setup.close()
        yield
        _sql(engine, "DELETE FROM customer_memberships WHERE id = 'MEMLOCK'")
        _sql(engine, "DELETE FROM membership_plans WHERE id = 'MBPLOCK'")
        _sql(engine, "DELETE FROM notification_deliveries WHERE customer_id = 'CUSLOCK'")
        _sql(engine, "DELETE FROM customers WHERE id = 'CUSLOCK'")

    def test_an_ended_membership_is_not_revived(self, engine, Session, pending, monkeypatch):
        from app.models import CustomerMembership
        from app.services import membership
        from app.services.email import notifications

        monkeypatch.setattr(notifications, "notify_membership", lambda *a, **k: None)
        mine = Session()
        try:
            # 1. The browser's verify call has the membership loaded, still pending.
            held = mine.get(CustomerMembership, "MEMLOCK")
            assert held.status == "pending"
            # 2. The webhook settled it first, and the store has since ended it.
            _sql(engine, "UPDATE customer_memberships SET status = 'cancelled', paid_at = '2026-01-02 00:00:00', "
                         "gateway_payment_id = 'pay_lock' WHERE id = 'MEMLOCK'")
            # 3. The browser's verify now tries to activate it.
            result = membership.activate(mine, held, payment_id="pay_lock", amount=99_900)
            assert result.status == "cancelled"
        finally:
            mine.rollback()
            mine.close()

    def test_a_pending_membership_still_activates(self, engine, Session, pending, monkeypatch):
        from app.models import CustomerMembership
        from app.services import membership
        from app.services.email import notifications

        monkeypatch.setattr(notifications, "notify_membership", lambda *a, **k: None)
        mine = Session()
        try:
            held = mine.get(CustomerMembership, "MEMLOCK")
            result = membership.activate(mine, held, payment_id="pay_ok", amount=99_900)
            assert result.status == "active" and result.paid_at is not None
            assert result.ends_at > result.starts_at
        finally:
            mine.close()
