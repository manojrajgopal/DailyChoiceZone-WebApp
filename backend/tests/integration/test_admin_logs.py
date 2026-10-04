"""
The full-page logs behind "View all": the email log and the member list,
filtered, searched and paged in the database.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture()
def emails(db):
    from app.models import EmailLog

    now = datetime.utcnow()
    rows = []
    for index in range(30):
        rows.append(EmailLog(
            email_type="order_confirmation" if index % 3 else "support_updates",
            recipient=f"person{index}@example.com",
            subject=f"Message number {index}",
            status="failed" if index % 10 == 0 else "sent",
            error="Mailbox full" if index % 10 == 0 else "",
            reference=f"DCZ1{index:04d}",
            created_at=now - timedelta(hours=30 - index),
        ))
    db.add_all(rows)
    db.flush()
    return rows


class TestEmailLog:
    def test_recent_takes_a_limit(self, client, admin_auth, emails):
        rows = client.get("/api/admin/email/log?limit=5", headers=admin_auth).json()["data"]
        assert [r["subject"] for r in rows] == [f"Message number {i}" for i in (29, 28, 27, 26, 25)]

    def test_pages_newest_first(self, client, admin_auth, emails):
        data = client.get("/api/admin/email/log/search?pageSize=10&page=2", headers=admin_auth).json()["data"]
        assert data["pagination"] == {"page": 2, "page_size": 10, "total": 30, "total_pages": 3}
        assert data["items"][0]["subject"] == "Message number 19"
        assert data["counts"] == {"sent": 27, "failed": 3}
        assert any(t["key"] == "support_updates" for t in data["types"])

    def test_filters_and_search(self, client, admin_auth, emails):
        failed = client.get("/api/admin/email/log/search?status=failed", headers=admin_auth).json()["data"]
        assert failed["pagination"]["total"] == 3 and all(r["error"] for r in failed["items"])
        # Counts ignore the status filter, so the tabs keep their numbers.
        assert failed["counts"]["sent"] == 27
        typed = client.get("/api/admin/email/log/search?type=support_updates", headers=admin_auth).json()["data"]
        assert typed["pagination"]["total"] == 10
        by_ref = client.get("/api/admin/email/log/search?q=DCZ10012", headers=admin_auth).json()["data"]
        assert [r["reference"] for r in by_ref["items"]] == ["DCZ10012"]
        # Typed with a leading # and in lower case: the same ID.
        assert client.get("/api/admin/email/log/search?q=%23dcz10012",
                          headers=admin_auth).json()["data"]["pagination"]["total"] == 1

    def test_reference_is_exact_and_recipient_never_identifies(self, client, admin_auth, emails):
        def total(params: str) -> int:
            response = client.get(f"/api/admin/email/log/search?{params}", headers=admin_auth)
            assert response.status_code == 200
            return response.json()["data"]["pagination"]["total"]

        # A partial or a longer reference is a different ID.
        assert total("q=DCZ1001") == 0
        assert total("q=DCZ100123") == 0
        # The recipient's address (or part of it) identifies a customer: never matched.
        assert total("q=person7@example.com") == 0
        assert total("q=person7") == 0
        # Junk is an empty list, not an error.
        assert total("q=%27%3B%20DROP%20TABLE%20email_log%3B--") == 0
        assert total("q=%25") == 0

    def test_subject_words_are_content(self, client, admin_auth, emails):
        data = client.get("/api/admin/email/log/search?subject=number%2017", headers=admin_auth).json()["data"]
        assert [r["subject"] for r in data["items"]] == ["Message number 17"]
        # % is the character itself, not a wildcard.
        assert client.get("/api/admin/email/log/search?subject=%25",
                          headers=admin_auth).json()["data"]["pagination"]["total"] == 0
        # A recipient's address is not in the subject, so it finds nothing here either.
        assert client.get("/api/admin/email/log/search?subject=person7",
                          headers=admin_auth).json()["data"]["pagination"]["total"] == 0

    def test_date_range(self, client, admin_auth, emails):
        since = (datetime.utcnow() - timedelta(hours=5, minutes=30)).isoformat()
        data = client.get(f"/api/admin/email/log/search?from={since}", headers=admin_auth).json()["data"]
        assert data["pagination"]["total"] == 5

    def test_settings_permission_required(self, client, editor, emails):
        from tests.integration.test_support import admin_login

        headers = admin_login(client, editor)
        assert client.get("/api/admin/email/log/search", headers=headers).status_code == 403


@pytest.fixture()
def members(db, customer, other_customer):
    from app.models import CustomerMembership, MembershipPlan

    now = datetime.utcnow()
    plans = [MembershipPlan(id="MBP901", name="Basic", duration_months=1, price=100, created_at=now, updated_at=now),
             MembershipPlan(id="MBP902", name="VIP", duration_months=12, price=999, created_at=now, updated_at=now)]
    db.add_all(plans)
    db.flush()
    statuses = ["active", "cancelled", "expired", "pending", "active", "cancelled"]
    for index, status in enumerate(statuses):
        owner = customer if index % 2 == 0 else other_customer
        plan = plans[index % 2]
        db.add(CustomerMembership(
            id=f"MEM9{index:02d}", customer_id=owner.id, plan_id=plan.id, plan_name=plan.name,
            duration_months=plan.duration_months, status=status, amount=plan.price * 100, benefits={},
            starts_at=now if status != "pending" else None, ends_at=now + timedelta(days=30) if status != "pending" else None,
            created_at=now - timedelta(minutes=index), updated_at=now,
        ))
    db.flush()


class TestMembers:
    def test_pages_and_counts(self, client, admin_auth, members):
        data = client.get("/api/admin/memberships/search?pageSize=2", headers=admin_auth).json()["data"]
        # "All" leaves out purchases that were never paid.
        assert data["pagination"]["total"] == 5 and data["pagination"]["total_pages"] == 3
        assert data["counts"] == {"active": 2, "pending": 1, "expired": 1, "cancelled": 2}
        assert [p["name"] for p in data["plans"]] == ["Basic", "VIP"]
        assert data["items"][0]["id"] == "MEM900"

    def test_awaiting_payment_can_be_listed(self, client, admin_auth, members):
        data = client.get("/api/admin/memberships/search?status=pending", headers=admin_auth).json()["data"]
        assert [r["id"] for r in data["items"]] == ["MEM903"]
        legacy = client.get("/api/admin/memberships?status=pending", headers=admin_auth).json()["data"]
        assert [r["id"] for r in legacy] == ["MEM903"]

    def test_search_by_customer_and_plan(self, client, admin_auth, members, other_customer):
        by_id = client.get(f"/api/admin/memberships/search?q={other_customer.id}", headers=admin_auth).json()["data"]
        assert by_id["items"] and all(r["customerEmail"] == other_customer.email for r in by_id["items"])
        by_email = client.get(f"/api/admin/memberships/search?q={other_customer.email}", headers=admin_auth).json()["data"]
        assert by_email["items"] == []
        by_plan = client.get("/api/admin/memberships/search?plan=MBP902", headers=admin_auth).json()["data"]
        assert all(r["planName"] == "VIP" for r in by_plan["items"])

    def test_recent_takes_a_limit(self, client, admin_auth, members):
        rows = client.get("/api/admin/memberships?limit=2", headers=admin_auth).json()["data"]
        assert len(rows) == 2
