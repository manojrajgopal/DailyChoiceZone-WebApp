"""
The portal's administration screens, the edges: administrators (adding,
changing, removing, and never locking the last super admin out), customers
(the list's figures, blocking and unblocking), the configuration-document
allowlist, the audit trail's filters and facets, and the webhook and delivery
screens' less common paths.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import select, text

from app.core import rate_limit
from app.core.permissions import permissions_for
from app.core.security import hash_password
from app.models import AdminUser, AuditLog, Order, WebhookEvent, WebhookEventAttempt, WishlistItem
from app.services import audit, webhooks

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def login(client, email, password="Admin@123"):
    return client.post("/api/admin/auth/login", json={"email": email, "password": password})


def headers_for(client, email, password="Admin@123"):
    response = login(client, email, password)
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


def second_super(db):
    user = AdminUser(id="ADM009", email="second.super@dailychoicezone.com", password_hash=hash_password("Admin@123"),
                     name="Second Super", role="super-admin", permissions=permissions_for("super-admin"),
                     status="active", created_at=datetime(2026, 1, 2))
    db.add(user)
    db.flush()
    return user


def order(db, oid, customer_id, total, status="confirmed", placed_at=None):
    db.add(Order(id=oid, order_number=f"DCZ-T-{oid}", customer_id=customer_id, customer_name="Asha Rao",
                 customer_email="shopper@example.com", placed_at=placed_at or datetime.utcnow(), status=status,
                 payment_status="paid", payment_method="upi", total=total, subtotal=total, item_count=1))
    db.flush()


# ----------------------------------------------------------- administrators


class TestListingAndAddingAdministrators:
    def test_everyone_who_can_sign_in_is_listed_without_secrets(self, client, admin_auth, editor):
        response = client.get("/api/admin/users", headers=admin_auth)
        assert response.status_code == 200
        people = {p["id"]: p for p in response.json()["data"]}
        assert set(people) == {"ADM001", "ADM002"}
        assert people["ADM001"]["avatarInitials"] == "MR" and people["ADM002"]["role"] == "editor"
        assert "password" not in response.text.lower()

    def test_an_administrator_is_added_with_the_roles_permissions(self, client, db, admin_auth):
        response = client.post("/api/admin/users", headers=admin_auth, json={
            "name": "Kiran Das", "email": "Kiran.Das@Example.com", "password": "Welcome@123", "role": "manager"})
        assert response.status_code == 201, response.text
        created = response.json()["data"]
        assert created["email"] == "kiran.das@example.com" and created["status"] == "active"
        assert created["permissions"] == permissions_for("manager")
        entry = db.query(AuditLog).filter_by(action="admins.create").one()
        assert entry.resource_id == created["id"] and entry.changes["role"]["to"] == "manager"
        assert "Welcome@123" not in str(entry.changes)
        assert login(client, "kiran.das@example.com", "Welcome@123").status_code == 200

    def test_the_default_role_is_staff_and_an_unknown_role_gets_nothing(self, client, admin_auth):
        staff = client.post("/api/admin/users", headers=admin_auth, json={
            "name": "Default Role", "email": "default.role@example.com", "password": "Welcome@123"}).json()["data"]
        assert staff["role"] == "staff" and staff["permissions"] == permissions_for("staff")
        odd = client.post("/api/admin/users", headers=admin_auth, json={
            "name": "Odd Role", "email": "odd.role@example.com", "password": "Welcome@123",
            "role": "wizard"}).json()["data"]
        assert odd["permissions"] == []

    @pytest.mark.parametrize("missing", ["name", "email", "password"])
    def test_a_name_email_and_password_are_required(self, client, db, admin_auth, missing):
        payload = {"name": "Kiran Das", "email": "kiran@example.com", "password": "Welcome@123"}
        payload.pop(missing)
        response = client.post("/api/admin/users", headers=admin_auth, json=payload)
        assert response.status_code == 422 and response.json()["error_code"] == "ADMIN_INCOMPLETE"
        assert db.query(AdminUser).count() == 1

    def test_an_email_already_in_use_is_refused_whatever_its_case(self, client, db, admin_auth):
        response = client.post("/api/admin/users", headers=admin_auth, json={
            "name": "Copy", "email": "ADMIN@dailychoicezone.com", "password": "Welcome@123"})
        assert response.status_code == 409 and response.json()["error_code"] == "EMAIL_TAKEN"

    @pytest.mark.parametrize("payload", [{"email": "not-an-email"}, {"password": "short"}, {"name": "x" * 161}])
    def test_malformed_fields_are_refused(self, client, admin_auth, payload):
        body = {"name": "Kiran Das", "email": "kiran@example.com", "password": "Welcome@123", **payload}
        assert client.post("/api/admin/users", headers=admin_auth, json=body).status_code == 422

    def test_only_the_admins_permission_may_add_one(self, client, db, admin, editor):
        from app.models import AdminUser as Model

        db.add(Model(id="ADM003", email="plain.admin@dailychoicezone.com", password_hash=hash_password("Admin@123"),
                     name="Plain Admin", role="admin", permissions=permissions_for("admin"), status="active",
                     created_at=datetime(2026, 1, 1)))
        db.flush()
        headers = headers_for(client, "plain.admin@dailychoicezone.com")
        response = client.post("/api/admin/users", headers=headers, json={
            "name": "Sneaky", "email": "sneaky@example.com", "password": "Welcome@123", "role": "super-admin"})
        assert response.status_code == 403
        assert client.put("/api/admin/users/ADM003", headers=headers, json={"role": "super-admin"}).status_code == 403


class TestChangingAdministrators:
    def test_an_unknown_administrator(self, client, admin_auth):
        for response in (client.put("/api/admin/users/ADM999", headers=admin_auth, json={"name": "X"}),
                         client.delete("/api/admin/users/ADM999", headers=admin_auth)):
            assert response.status_code == 404 and response.json()["error_code"] == "ADMIN_NOT_FOUND"

    def test_name_email_role_status_and_password_change_and_are_audited(self, client, db, admin_auth, editor):
        response = client.put("/api/admin/users/ADM002", headers=admin_auth, json={
            "name": "Priya S", "email": "Priya.New@Example.com", "role": "manager", "password": "Changed@456"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["name"] == "Priya S" and data["email"] == "priya.new@example.com"
        assert data["role"] == "manager" and data["permissions"] == permissions_for("manager")
        assert data["avatarInitials"] == "PS"
        entry = db.query(AuditLog).filter_by(action="admins.update").one()
        assert entry.changes["password"] == audit.REDACTED  # the whole field, not just its values
        assert entry.changes["role"] == {"from": "editor", "to": "manager"}
        assert "Changed@456" not in str(entry.changes) and "(" in entry.summary
        assert login(client, "priya.new@example.com", "Changed@456").status_code == 200

    def test_a_save_that_changes_nothing_records_no_changes(self, client, db, admin_auth, editor):
        response = client.put("/api/admin/users/ADM002", headers=admin_auth, json={"name": "Priya Sharma"})
        assert response.status_code == 200
        entry = db.query(AuditLog).filter_by(action="admins.update").one()
        assert entry.changes is None and entry.summary == "Changed administrator Priya Sharma"

    def test_a_suspended_administrator_cannot_sign_in(self, client, db, admin_auth, editor):
        assert client.put("/api/admin/users/ADM002", headers=admin_auth,
                          json={"status": "suspended"}).json()["data"]["status"] == "suspended"
        response = login(client, editor.email)
        assert response.status_code == 403 and response.json()["error_code"] == "ACCOUNT_BLOCKED"

    def test_an_email_another_administrator_uses_is_refused(self, client, db, admin_auth, editor):
        response = client.put("/api/admin/users/ADM002", headers=admin_auth,
                              json={"email": "admin@dailychoicezone.com"})
        assert response.status_code == 409
        db.rollback()

    @pytest.mark.parametrize("payload", [{"role": "admin"}, {"status": "suspended"}])
    def test_the_last_super_admin_cannot_be_demoted_or_suspended(self, client, db, admin_auth, payload):
        response = client.put("/api/admin/users/ADM001", headers=admin_auth, json=payload)
        assert response.status_code == 409 and response.json()["error_code"] == "LAST_SUPER_ADMIN"
        db.expire_all()
        assert db.get(AdminUser, "ADM001").role == "super-admin"
        assert db.get(AdminUser, "ADM001").status == "active"

    # Regression: was a real bug, fixed alongside this test.
    def test_the_last_super_admin_cannot_be_made_inactive_by_another_name(self, client, db, admin_auth):
        response = client.put("/api/admin/users/ADM001", headers=admin_auth, json={"status": "inactive"})
        assert response.status_code == 409

    def test_a_super_admin_can_be_demoted_while_another_remains(self, client, db, admin_auth):
        second_super(db)
        response = client.put("/api/admin/users/ADM009", headers=admin_auth, json={"role": "admin"})
        assert response.status_code == 200 and response.json()["data"]["role"] == "admin"
        assert "admins" not in response.json()["data"]["permissions"]


class TestRemovingAdministrators:
    def test_an_administrator_is_removed_and_the_removal_audited(self, client, db, admin_auth, editor):
        response = client.delete("/api/admin/users/ADM002", headers=admin_auth)
        assert response.status_code == 200 and response.json()["message"] == "Administrator removed."
        db.expire_all()
        assert db.get(AdminUser, "ADM002") is None
        entry = db.query(AuditLog).filter_by(action="admins.delete").one()
        assert entry.changes["email"] == {"from": "editor@dailychoicezone.com", "to": None}

    def test_you_cannot_remove_yourself(self, client, db, admin_auth):
        second_super(db)
        response = client.delete("/api/admin/users/ADM001", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "SELF_DELETE"

    def test_a_super_admin_is_removed_when_another_remains(self, client, db, admin_auth):
        second_super(db)
        assert client.delete("/api/admin/users/ADM009", headers=admin_auth).status_code == 200

class TestLastSuperAdminRemoval:
    def test_removing_the_last_active_super_admin_is_refused(self, client, db, admin):
        """A staff member with the admins permission removing the only active super admin."""
        db.add(AdminUser(id="ADM020", email="ops@dailychoicezone.com", password_hash=hash_password("Admin@123"),
                         name="Ops Lead", role="staff", permissions=["admins"], status="active",
                         created_at=datetime(2026, 1, 1)))
        db.flush()
        headers = headers_for(client, "ops@dailychoicezone.com")
        response = client.delete("/api/admin/users/ADM001", headers=headers)
        assert response.status_code == 409 and response.json()["error_code"] == "LAST_SUPER_ADMIN"
        db.expire_all()
        assert db.get(AdminUser, "ADM001") is not None


# ------------------------------------------------------------- customers


class TestCustomers:
    def test_the_list_carries_each_customers_orders_spend_and_wishlist(self, client, db, catalogue, customer,
                                                                       other_customer, admin_auth):
        order(db, "ORD901", "CUS001", 1500)
        order(db, "ORD902", "CUS001", 500, placed_at=datetime.utcnow() - timedelta(days=3))
        order(db, "ORD903", "CUS001", 9999, status="cancelled")
        db.add(WishlistItem(customer_id="CUS001", product_id="PRD001"))
        db.flush()
        response = client.get("/api/admin/customers", headers=admin_auth)
        assert response.status_code == 200
        people = {c["id"]: c for c in response.json()["data"]}
        asha = people["CUS001"]
        assert asha["orderCount"] == 2 and asha["totalSpent"] == 2000.0 and asha["lastOrderAt"]
        assert asha["wishlistProductIds"] == ["PRD001"]
        assert asha["addresses"][0]["id"] == "ADR001" and asha["addresses"][0]["isDefault"] is True
        assert people["CUS002"]["orderCount"] == 0 and people["CUS002"]["wishlistProductIds"] == []
        assert "password" not in response.text.lower()

    def test_one_customer(self, client, db, catalogue, customer, admin_auth):
        order(db, "ORD904", "CUS001", 750)
        db.add(WishlistItem(customer_id="CUS001", product_id="PRD002"))
        db.flush()
        data = client.get("/api/admin/customers/CUS001", headers=admin_auth).json()["data"]
        assert data["email"] == "shopper@example.com" and data["totalSpent"] == 750.0
        assert data["wishlistProductIds"] == ["PRD002"]
        missing = client.get("/api/admin/customers/CUS999", headers=admin_auth)
        assert missing.status_code == 404 and missing.json()["error_code"] == "CUSTOMER_NOT_FOUND"

    def test_blocking_takes_effect_at_once_and_unblocking_restores_access(self, client, db, customer, auth,
                                                                          admin_auth):
        response = client.put("/api/admin/customers/CUS001/status", headers=admin_auth, json={"status": "blocked"})
        assert response.status_code == 200 and response.json()["message"] == "Customer blocked."
        assert response.json()["data"]["status"] == "blocked"
        assert client.get("/api/auth/me", headers=auth).status_code in (401, 403)
        client.put("/api/admin/customers/CUS001/status", headers=admin_auth, json={"status": "active"})
        assert client.get("/api/auth/me", headers=auth).status_code == 200

    def test_an_unknown_customer_cannot_be_blocked(self, client, admin_auth):
        response = client.put("/api/admin/customers/CUS999/status", headers=admin_auth, json={"status": "blocked"})
        assert response.status_code == 404 and response.json()["error_code"] == "CUSTOMER_NOT_FOUND"

    def test_blocking_needs_the_customers_permission(self, client, db, customer, editor):
        response = client.put("/api/admin/customers/CUS001/status", headers=headers_for(client, editor.email),
                              json={"status": "blocked"})
        assert response.status_code == 403
        db.expire_all()
        assert customer.status == "active"

    # Regression: was a real bug, fixed alongside this test.
    def test_an_unknown_status_is_refused(self, client, db, customer, admin_auth):
        response = client.put("/api/admin/customers/CUS001/status", headers=admin_auth, json={"status": "blokced"})
        assert response.status_code == 422


# ---------------------------------------------------------------- settings


class TestConfigurationDocuments:
    def test_a_document_outside_the_allowlist_cannot_be_written(self, client, db, admin_auth):
        from app.models import SettingDocument

        response = client.put("/api/admin/settings/backups", headers=admin_auth, json={"enabled": False})
        assert response.status_code == 404 and response.json()["error_code"] == "UNKNOWN_DOCUMENT"
        assert db.get(SettingDocument, "backups") is None

    def test_an_unsaved_document_reads_as_empty_and_is_created_on_save(self, client, admin_auth):
        assert client.get("/api/admin/settings/navigation", headers=admin_auth).json()["data"] == {}
        saved = client.put("/api/admin/settings/navigation", headers=admin_auth, json={"links": []})
        assert saved.status_code == 200 and saved.json()["message"] == "Settings saved."
        assert client.get("/api/admin/settings/navigation", headers=admin_auth).json()["data"] == {"links": []}


# ------------------------------------------------------------ audit trail


def entry(db, *, action, resource_type="orders", resource_id="ORD1", actor_id="ADM001", actor_name="Manoj Rajan",
          outcome="success", when=None, summary="Did a thing"):
    row = AuditLog(occurred_at=when or datetime.utcnow(), action=action, resource_type=resource_type,
                   resource_id=resource_id, actor_type="admin" if actor_id else "system", actor_id=actor_id,
                   actor_name=actor_name, actor_email="", actor_role="", summary=summary, outcome=outcome,
                   error_code="", ip_address="", user_agent="", request_id="")
    db.add(row)
    db.flush()
    return row


class TestAuditTrailFilters:
    @pytest.fixture()
    def trail(self, db, admin, editor):
        now = datetime.utcnow()
        return {
            "old": entry(db, action="orders.update", when=datetime(2026, 3, 10, 12, 0), resource_id="ORD7"),
            "denied": entry(db, action="settings.update", resource_type="settings", resource_id="store",
                            actor_id="ADM002", actor_name="Priya Sharma", outcome="denied", when=now),
            "failed": entry(db, action="orders.cancel", resource_id="ORD8", outcome="failure", when=now),
            "system": entry(db, action="backups.run", resource_type="backups", resource_id="manual", actor_id=None,
                            actor_name="", when=now),
        }

    def ids(self, client, headers, query):
        response = client.get(f"/api/admin/audit-logs?{query}", headers=headers)
        assert response.status_code == 200, response.text
        return {i["id"] for i in response.json()["data"]["items"]}, response.json()["data"]

    def test_each_filter_narrows_the_trail(self, client, admin_auth, trail):
        assert self.ids(client, admin_auth, "action=orders")[0] == {trail["old"].id, trail["failed"].id}
        assert self.ids(client, admin_auth, "resourceType=settings")[0] == {trail["denied"].id}
        assert self.ids(client, admin_auth, "resourceId=ORD8")[0] == {trail["failed"].id}
        assert self.ids(client, admin_auth, "actor=ADM002")[0] == {trail["denied"].id}
        found, data = self.ids(client, admin_auth, "outcome=failure")
        assert found == {trail["failed"].id}
        assert data["counts"] == {"success": 0, "failure": 1, "denied": 0}
        # An outcome outside the three is ignored rather than matching nothing.
        assert trail["old"].id in self.ids(client, admin_auth, "outcome=maybe")[0]

    def test_dates_are_whole_days(self, client, admin_auth, trail):
        assert self.ids(client, admin_auth, "from=2026-03-10&to=2026-03-10")[0] == {trail["old"].id}
        assert self.ids(client, admin_auth, "to=2026-03-09")[0] == set()
        assert trail["old"].id not in self.ids(client, admin_auth, "from=2026-03-11")[0]

    # Regression: was a real bug, fixed alongside this test.
    def test_an_end_with_a_time_is_an_exact_bound(self, client, admin_auth, trail):
        assert self.ids(client, admin_auth, "from=2026-03-01&to=2026-03-10T11:00:00")[0] == set()
        assert self.ids(client, admin_auth, "from=2026-03-01&to=2026-03-10T13:00:00")[0] == {trail["old"].id}

    def test_the_export_follows_the_same_filters(self, client, admin_auth, trail):
        response = client.get("/api/admin/audit-logs/export?actor=ADM002", headers=admin_auth)
        assert response.status_code == 200 and response.headers["content-type"].startswith("text/csv")
        lines = response.text.strip().splitlines()
        assert len(lines) == 2 and "settings.update" in lines[1]

    def test_the_facets_list_record_types_and_people(self, client, db, admin_auth, trail):
        response = client.get("/api/admin/audit-logs/facets", headers=admin_auth)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert {"orders", "settings", "backups"} <= set(data["resourceTypes"])
        actors = {a["id"]: a["name"] for a in data["actors"]}
        assert actors["ADM002"] == "Priya Sharma" and actors["ADM001"] == "Manoj Rajan"
        assert None not in actors

    def test_an_actor_without_a_name_is_shown_by_id(self, client, db, admin_auth):
        entry(db, action="x.y", actor_id="ADM077", actor_name="")
        actors = {a["id"]: a["name"] for a in
                  client.get("/api/admin/audit-logs/facets", headers=admin_auth).json()["data"]["actors"]}
        assert actors["ADM077"] == "ADM077"

    def test_the_facets_and_entries_need_the_audit_permission(self, client, editor, trail):
        headers = headers_for(client, editor.email)
        assert client.get("/api/admin/audit-logs/facets", headers=headers).status_code == 403
        assert client.get(f"/api/admin/audit-logs/{trail['old'].id}", headers=headers).status_code == 403

    def test_an_unknown_entry(self, client, admin_auth):
        response = client.get("/api/admin/audit-logs/987654321", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "AUDIT_ENTRY_NOT_FOUND"


class TestAuditRecording:
    def test_an_unrecognised_actor_is_recorded_as_the_system(self, db):
        row = audit.record(db, "jobs.ran", actor=object(), summary="A job ran")
        assert row.actor_type == "system" and row.actor_id is None

    def test_a_customer_actor_is_recorded_as_a_customer(self, db, customer):
        row = audit.record(db, "account.update", actor=customer)
        assert row.actor_type == "customer" and row.actor_id == "CUS001" and row.actor_name == "Asha Rao"

    def test_a_refusal_whose_entry_cannot_be_written_never_becomes_a_500(self, db, monkeypatch):
        def broken(db, entry):
            raise RuntimeError("audit table locked")

        monkeypatch.setattr(audit, "_write_detached", broken)
        audit.record_now(db, "auth.login_failed", summary="nope")  # logged, not raised

    def test_a_detached_entry_on_an_engine_uses_its_own_transaction(self, engine):
        """Outside the suite the session is bound to an engine; the entry is removed again afterwards."""
        from sqlalchemy.orm import Session

        marker = f"engine-entry-{datetime.utcnow().timestamp()}"
        session = Session(bind=engine)
        try:
            audit.record_now(session, "test.engine", summary=marker, system=True)
            with engine.connect() as connection:
                count = connection.execute(text("SELECT COUNT(*) FROM audit_logs WHERE summary = :s"),
                                           {"s": marker}).scalar()
            assert count == 1
        finally:
            with engine.begin() as connection:
                connection.execute(text("DELETE FROM audit_logs WHERE summary = :s"), {"s": marker})
            session.close()

    def test_a_forged_token_on_a_portal_change_is_recorded_as_denied(self, client, db):
        response = client.put("/api/admin/settings/store", headers={"Authorization": "Bearer not.a.token"},
                              json={"a": 1})
        assert response.status_code == 401
        row = db.execute(select(AuditLog).where(AuditLog.outcome == "denied")).scalars().one()
        assert row.actor_type == "anonymous" and row.status_code == 401
        assert row.details["path"] == "/api/admin/settings/store"

    def test_a_signed_token_for_neither_kind_of_account_is_recorded_as_anonymous(self, client, db):
        from app.core.security import create_access_token

        token = create_access_token("BOT001", "robot")
        response = client.put("/api/admin/settings/store", headers={"Authorization": f"Bearer {token}"},
                              json={"a": 1})
        assert response.status_code == 403
        row = db.execute(select(AuditLog).where(AuditLog.outcome == "denied")).scalars().one()
        assert row.actor_type == "anonymous" and row.actor_id is None
    def test_a_portal_change_that_crashes_is_recorded_as_a_server_error(self, client, db, admin_auth, monkeypatch):
        from app.services import backups

        def crash(*a, **k):
            raise RuntimeError("unexpected")

        monkeypatch.setattr(backups, "save_settings", crash)
        response = client.put("/api/admin/backups/settings", headers=admin_auth, json={"enabled": False})
        assert response.status_code == 500
        row = db.execute(select(AuditLog).where(AuditLog.outcome == "failure")).scalars().one()
        assert row.status_code == 500 and row.error_code == "SERVER_ERROR" and row.actor_id == "ADM001"

    def test_a_trail_that_cannot_be_written_never_breaks_the_response(self, client, admin_auth, monkeypatch):
        def broken(*a, **k):
            raise RuntimeError("trail down")

        monkeypatch.setattr(audit, "_write_generic", broken)
        response = client.put("/api/admin/settings/unknown-doc", headers=admin_auth, json={})
        assert response.status_code == 404 and response.json()["error_code"] == "UNKNOWN_DOCUMENT"


# -------------------------------------------------------------- webhooks


def webhook(db, event_id, *, status="processed", event="payment.captured", payload=None, duplicates=0,
            received_at=None):
    now = received_at or datetime.utcnow()
    row = WebhookEvent(event_id=event_id, event=event, result="", received_at=now, status=status, attempts=1,
                       duplicates=duplicates, started_at=now, completed_at=now, error="", payload=payload,
                       gateway_payment_id="pay_x1" if event_id.endswith("1") else None)
    db.add(row)
    db.flush()
    return row


class TestWebhookScreens:
    def test_filters_by_duplicates_event_age_and_search(self, client, db, admin_auth):
        webhook(db, "evt_a1", duplicates=2)
        webhook(db, "evt_b2", event="refund.processed")
        webhook(db, "evt_c3", received_at=datetime.utcnow() - timedelta(days=10))
        data = client.get("/api/admin/payments/webhooks?status=duplicates", headers=admin_auth).json()["data"]
        assert [i["eventId"] for i in data["items"]] == ["evt_a1"]
        data = client.get("/api/admin/payments/webhooks?event=refund.processed", headers=admin_auth).json()["data"]
        assert [i["eventId"] for i in data["items"]] == ["evt_b2"]
        assert data["events"] == ["payment.captured", "refund.processed"]
        data = client.get("/api/admin/payments/webhooks?days=7", headers=admin_auth).json()["data"]
        assert {i["eventId"] for i in data["items"]} == {"evt_a1", "evt_b2"}
        data = client.get("/api/admin/payments/webhooks?q=pay_x1", headers=admin_auth).json()["data"]
        assert [i["eventId"] for i in data["items"]] == ["evt_a1"]

    def test_filtering_by_status(self, client, db, admin_auth):
        webhook(db, "evt_ok1")
        webhook(db, "evt_bad2", status="failed")
        data = client.get("/api/admin/payments/webhooks?status=failed", headers=admin_auth).json()["data"]
        assert [i["eventId"] for i in data["items"]] == ["evt_bad2"]

    def test_a_replay_refused_by_settlement_is_passed_on(self, client, db, admin_auth, monkeypatch):
        from app.core.errors import ValidationError
        from app.services import settlement

        webhook(db, "evt_inv", status="failed", payload={"event": "payment.captured", "payload": {}})
        db.commit()

        def refuse(db, body):
            raise ValidationError("Amount does not match.", error_code="AMOUNT_MISMATCH")

        monkeypatch.setattr(settlement, "settle_from_webhook", refuse)
        response = client.post("/api/admin/payments/webhooks/evt_inv/replay", headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "AMOUNT_MISMATCH"
        db.expire_all()
        assert db.get(WebhookEvent, "evt_inv").status == "failed"
    def test_unknown_events(self, client, admin_auth):
        for response in (client.get("/api/admin/payments/webhooks/evt_nope", headers=admin_auth),
                         client.post("/api/admin/payments/webhooks/evt_nope/replay", headers=admin_auth)):
            assert response.status_code == 404 and response.json()["error_code"] == "WEBHOOK_NOT_FOUND"

    def test_an_event_recorded_without_its_payload_cannot_be_replayed(self, client, db, admin_auth):
        webhook(db, "evt_old", status="failed", payload=None)
        response = client.post("/api/admin/payments/webhooks/evt_old/replay", headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "WEBHOOK_NO_PAYLOAD"
        assert client.get("/api/admin/payments/webhooks/evt_old", headers=admin_auth).json()["data"][
            "replayable"] is False

    def test_a_replay_that_fails_again_is_reported_not_raised(self, client, db, admin_auth, monkeypatch):
        from app.services import settlement

        webhook(db, "evt_bad", status="failed", payload={"event": "payment.captured", "payload": {}})
        db.commit()

        def broken(db, body):
            raise RuntimeError("settlement down")

        def unlinkable(db, body):
            raise RuntimeError("lookup down")

        monkeypatch.setattr(settlement, "settle_from_webhook", broken)
        monkeypatch.setattr(webhooks, "_related", unlinkable)
        response = client.post("/api/admin/payments/webhooks/evt_bad/replay", headers=admin_auth)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["message"] == "Replayed — processing failed again."
        assert body["data"]["outcome"]["failed"] is True and "settlement down" in body["data"]["outcome"]["error"]
        attempts = db.execute(select(WebhookEventAttempt).where(WebhookEventAttempt.event_id == "evt_bad")
                              ).scalars().all()
        assert [(a.trigger, a.outcome) for a in attempts] == [("replay", "failed")]

    def test_only_a_failed_event_is_replayed_even_when_asked_directly(self, db):
        webhook(db, "evt_done")
        db.commit()
        from app.core.errors import ConflictError

        with pytest.raises(ConflictError) as error:
            webhooks.process(db, "evt_done", {"event": "payment.captured"}, trigger="replay", admin_id="ADM001")
        assert error.value.error_code == "WEBHOOK_NOT_FAILED"

    def test_only_dictionaries_are_kept_from_an_entity(self):
        assert webhooks._clean_entity(["not", "a", "dict"]) == {}
        assert webhooks._clean_entity({"id": "pay_1", "card": {"network": "Visa", "last4": "4242"},
                                       "email": "a@b.c"}) == {"id": "pay_1", "card": {"network": "Visa"}}


# -------------------------------------------------------------- delivery


class TestDeliveryScreens:
    def add(self, client, headers, **values):
        body = {"pincode": "560001", "city": "Bengaluru", "state": "Karnataka", **values}
        response = client.post("/api/admin/delivery/pincodes", headers=headers, json=body)
        assert response.status_code == 201, response.text
        return response.json()["data"]

    def test_the_settings_are_read_and_saved(self, client, db, admin_auth):
        from app.services import serviceability

        # Every setting at its default — `restrictToListed`, and the delivery
        # estimate's dispatch rules (docs/product-discovery.md).
        assert client.get("/api/admin/delivery/settings", headers=admin_auth).json()["data"] == \
            serviceability.DEFAULTS
        assert serviceability.DEFAULTS["restrictToListed"] is False
        for value in (True, False, True):
            saved = client.put("/api/admin/delivery/settings", headers=admin_auth, json={"restrictToListed": value})
            assert saved.status_code == 200 and saved.json()["data"]["restrictToListed"] is value
        assert client.get("/api/delivery/pincodes/400001").json()["data"]["serviceable"] is False

    def test_an_entry_is_removed_and_a_missing_one_is_404(self, client, admin_auth):
        row = self.add(client, admin_auth)
        assert client.delete(f"/api/admin/delivery/pincodes/{row['id']}", headers=admin_auth).json()[
            "message"] == "Pincode removed."
        for response in (client.delete(f"/api/admin/delivery/pincodes/{row['id']}", headers=admin_auth),
                         client.put(f"/api/admin/delivery/pincodes/{row['id']}", headers=admin_auth,
                                    json={"pincode": "560001"})):
            assert response.status_code == 404 and response.json()["error_code"] == "NOT_FOUND"

    def test_an_entry_cannot_be_renamed_onto_another(self, client, admin_auth):
        self.add(client, admin_auth)
        other = self.add(client, admin_auth, pincode="560002")
        response = client.put(f"/api/admin/delivery/pincodes/{other['id']}", headers=admin_auth,
                              json={"pincode": "560001"})
        assert response.status_code == 409 and response.json()["error_code"] == "DUPLICATE"
        same = client.put(f"/api/admin/delivery/pincodes/{other['id']}", headers=admin_auth,
                          json={"pincode": "560002", "city": "Bangalore"})
        assert same.status_code == 200 and same.json()["data"]["city"] == "Bangalore"

    def test_the_list_filters_by_state(self, client, admin_auth):
        self.add(client, admin_auth)
        self.add(client, admin_auth, pincode="400001", city="Mumbai", state="Maharashtra")
        data = client.get("/api/admin/delivery/pincodes?state=Maharashtra", headers=admin_auth).json()["data"]
        assert [i["pincode"] for i in data["items"]] == ["400001"]
        assert data["states"] == ["Karnataka", "Maharashtra"]

    def test_a_csv_without_a_header_is_refused(self, client, admin_auth):
        response = client.post("/api/admin/delivery/pincodes/import", headers=admin_auth,
                               json={"content": "560001,Bengaluru\n"})
        assert response.status_code == 422 and response.json()["error_code"] == "CSV_HEADER"

    def test_blank_rows_are_skipped(self, client, admin_auth):
        response = client.post("/api/admin/delivery/pincodes/import", headers=admin_auth,
                               json={"content": "﻿pincode,city\n560001,Bengaluru\n,\n560002,Bengaluru\n"})
        assert response.status_code == 200, response.text
        assert response.json()["data"] == {"created": 2, "updated": 0, "errors": [], "errorCount": 0}

    def test_an_import_is_capped(self, client, admin_auth):
        rows = "\n".join(str(110001 + i) for i in range(5001))
        response = client.post("/api/admin/delivery/pincodes/import", headers=admin_auth,
                               json={"content": "pincode\n" + rows})
        assert response.status_code == 422 and response.json()["error_code"] == "CSV_TOO_LARGE"

    def test_a_pincode_is_valid_with_spaces_inside(self):
        from app.services import serviceability

        assert serviceability.valid("560 001") is True
        assert serviceability.valid("060001") is False
