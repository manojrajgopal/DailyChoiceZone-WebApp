"""
The audit trail: every change an administrator makes is recorded by the
server, with what changed; secrets never are; entries can't be edited or
removed; and only those allowed can read it.
"""

from __future__ import annotations

import pytest

from app.core import rate_limit
from app.models import AuditLog
from app.services import audit

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def entries(db, **filters):
    db.expire_all()
    return db.query(AuditLog).filter_by(**filters).order_by(AuditLog.id).all()


class TestRecording:
    def test_a_price_change_is_recorded_with_before_and_after(self, client, db, catalogue, admin_auth):
        response = client.put("/api/products/PRD001", headers=admin_auth, json={"price": 899})
        assert response.status_code == 200, response.text
        [entry] = entries(db, action="products.update", resource_id="PRD001")
        assert entry.actor_id == "ADM001" and entry.actor_name == "Manoj Rajan" and entry.actor_role == "super-admin"
        assert entry.changes["price"] == {"from": 1000.0, "to": 899.0}
        assert entry.outcome == "success" and entry.request_id

    def test_changes_without_their_own_entry_get_a_generic_one(self, client, db, catalogue, admin_auth):
        response = client.post("/api/products/PRD001/duplicate", headers=admin_auth)
        assert response.status_code == 201, response.text
        [entry] = entries(db, action="products.duplicate")
        assert entry.resource_type == "products" and entry.resource_id == "PRD001"
        assert entry.summary == "Duplicate a product as a draft"
        assert entry.details == {"method": "POST", "path": "/api/products/PRD001/duplicate"}

    def test_a_failed_change_is_recorded_and_the_work_is_not(self, client, db, catalogue, admin_auth):
        response = client.put("/api/admin/orders/NOPE/status", headers=admin_auth, json={"status": "shipped"})
        assert response.status_code == 404
        [entry] = entries(db, action="orders.status")
        assert entry.outcome == "failure" and entry.status_code == 404 and entry.error_code == "ORDER_NOT_FOUND"
        # The test's own data survived: the trail wrote on its own transaction.
        assert client.get("/api/products/PRD001").status_code == 200

    def test_a_refused_permission_is_recorded(self, client, db, editor, catalogue):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}).json()
        headers = {"Authorization": f"Bearer {token['data']['token']['accessToken']}"}
        assert client.get("/api/admin/flash-sales", headers=headers).status_code == 403
        [entry] = entries(db, outcome="denied", actor_id=editor.id)
        assert entry.status_code == 403 and entry.error_code == "PERMISSION_DENIED"

    def test_customers_own_changes_are_not_in_the_portal_trail(self, client, db, catalogue, customer, auth,
                                                               settings_documents):
        before = {e.id for e in entries(db)}  # the fixture's sign-in is a recorded security event
        client.post("/api/cart/items", headers=auth, json={"productId": "PRD001", "quantity": 1})
        assert [e for e in entries(db) if e.id not in before] == []

    def test_sign_ins_are_recorded_and_the_password_never_is(self, client, db, admin):
        assert client.post("/api/admin/auth/login", json={"email": admin.email, "password": "Wrong@1234"}).status_code == 401
        assert client.post("/api/admin/auth/login", json={"email": admin.email, "password": "Admin@123"}).status_code == 200
        failed, ok = entries(db, action="auth.login_failed"), entries(db, action="auth.login")
        assert failed[0].outcome == "denied" and failed[0].details["email"] == admin.email
        assert ok[0].actor_id == admin.id
        everything = str([(e.changes, e.details, e.summary) for e in entries(db)])
        assert "Wrong@1234" not in everything and "Admin@123" not in everything

    def test_a_password_change_is_recorded_as_redacted(self, client, db, admin_auth, editor):
        response = client.put(f"/api/admin/users/{editor.id}", headers=admin_auth,
                              json={"password": "Newpass@123", "role": "manager"})
        assert response.status_code == 200, response.text
        [entry] = entries(db, action="admins.update")
        assert entry.changes["password"] == "[redacted]"
        assert entry.changes["role"] == {"from": "editor", "to": "manager"}
        assert "Newpass@123" not in str(entry.changes)


class TestRedaction:
    def test_secrets_are_blanked_by_name_and_by_shape(self):
        clean = audit.redact({
            "password": "x", "clientSecret": "y", "api_key": "z", "refreshToken": "t", "giftCardCode": "DCZG-1",
            "cardNumber": "4111", "pincode": "560001", "note": "Bearer abc.def.ghi", "key": "rzp_live_abcdef",
            "nested": [{"otp": "1234", "name": "ok"}],
        })
        for field in ("password", "clientSecret", "api_key", "refreshToken", "giftCardCode", "cardNumber", "note",
                      "key"):
            assert clean[field] == "[redacted]", field
        assert clean["pincode"] == "560001"
        assert clean["nested"] == [{"otp": "[redacted]", "name": "ok"}]


class TestImmutable:
    def test_an_entry_cannot_be_changed_or_deleted(self, client, db, catalogue, admin_auth):
        client.put("/api/products/PRD001", headers=admin_auth, json={"price": 899})
        [entry] = entries(db, action="products.update")
        entry.summary = "Nothing happened"
        with pytest.raises(audit.AuditLogImmutable):
            db.flush()
        db.rollback()
        [entry] = entries(db, action="products.update")
        db.delete(entry)
        with pytest.raises(audit.AuditLogImmutable):
            db.flush()
        db.rollback()
        with pytest.raises(audit.AuditLogImmutable):
            db.query(AuditLog).delete()
        db.rollback()

    def test_there_is_no_endpoint_to_change_one(self, client, db, catalogue, admin_auth):
        client.put("/api/products/PRD001", headers=admin_auth, json={"price": 899})
        [entry] = entries(db, action="products.update")
        assert client.put(f"/api/admin/audit-logs/{entry.id}", headers=admin_auth, json={}).status_code == 405
        assert client.delete(f"/api/admin/audit-logs/{entry.id}", headers=admin_auth).status_code == 405


class TestReading:
    def test_the_trail_is_filtered_paged_and_exported(self, client, db, catalogue, admin_auth):
        client.put("/api/products/PRD001", headers=admin_auth, json={"price": 899})
        client.put("/api/products/PRD002", headers=admin_auth, json={"stock": 4})
        body = client.get("/api/admin/audit-logs?resourceType=products&pageSize=1", headers=admin_auth).json()["data"]
        assert body["pagination"]["total"] == 2 and len(body["items"]) == 1
        one = client.get(f"/api/admin/audit-logs/{body['items'][0]['id']}", headers=admin_auth).json()["data"]
        assert one["changes"] and one["actor"]["id"] == "ADM001"
        found = client.get("/api/admin/audit-logs?q=PRD002", headers=admin_auth).json()["data"]
        assert [i["resourceId"] for i in found["items"]] == ["PRD002"]
        csv = client.get("/api/admin/audit-logs/export?resourceType=products", headers=admin_auth)
        assert csv.status_code == 200 and csv.headers["content-type"].startswith("text/csv")
        assert "products.update" in csv.text

    def test_only_the_super_admin_or_those_granted_it_can_read(self, client, db, admin, editor, auth):
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}).json()
        headers = {"Authorization": f"Bearer {token['data']['token']['accessToken']}"}
        assert client.get("/api/admin/audit-logs", headers=headers).status_code == 403
        assert client.get("/api/admin/audit-logs", headers=auth).status_code == 403
        assert client.get("/api/admin/audit-logs").status_code == 401
