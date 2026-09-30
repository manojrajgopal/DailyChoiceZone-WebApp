"""
The support centre: categories and routing, raising tickets, who can see
what, the lifecycle, the conversation, attachments, SLAs and escalation.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from tests.integration.test_email import connect, outbox  # noqa: F401 — fixture

pytestmark = pytest.mark.integration

PNG = b"\x89PNG\r\n\x1a\n" + bytes(64)


@pytest.fixture(autouse=True)
def _fresh_limits():
    from app.core import rate_limit

    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def support(db):
    """The starting configuration a new store gets from its migration."""
    from app.support_defaults import install

    install(db.connection())
    db.flush()
    return db


@pytest.fixture()
def stored(monkeypatch):
    """Private storage, switched on and recorded instead of reaching S3."""
    from app.services import storage

    saved = {}
    monkeypatch.setattr(storage, "is_configured", lambda: True)
    monkeypatch.setattr(storage, "put_private", lambda data, key, kind: saved.__setitem__(key, (data, kind)))
    monkeypatch.setattr(storage, "signed_url", lambda key, name, inline, expires=300: f"https://signed.test/{key}")

    # PNGs are re-encoded; a stand-in decoder keeps the test bytes simple.
    from app.services.support import attachments

    monkeypatch.setattr(attachments, "_clean_image", lambda data, kind, shown: data)
    return saved


def node(client, *path):
    """The id of a category path such as ("Payments", "UPI Issue")."""
    tree = client.get("/api/support/config").json()["data"]["categories"]
    ids, level = [], tree
    for name in path:
        match = next(n for n in level if n["name"] == name)
        ids.append(match["id"])
        level = match["children"]
    return ids


def raise_ticket(client, headers=None, *path, files=None, **fields):
    import json

    ids = node(client, *path)
    payload = {"categoryId": ids[0], "subcategoryId": ids[1] if len(ids) > 1 else None,
               "issueId": ids[2] if len(ids) > 2 else None, "description": "Something is not right here.",
               **fields}
    return client.post("/api/support/tickets", headers=headers or {},
                       data={"data": json.dumps(payload)}, files=files or [])


def team_id(client, admin_auth, name):
    teams = client.get("/api/admin/support/config", headers=admin_auth).json()["data"]["teams"]
    return next(t["id"] for t in teams if t["name"] == name)


def add_agent(client, admin_auth, name, team, **extra):
    response = client.post("/api/admin/support/config/agents", headers=admin_auth, json={
        "name": name, "email": f"{name.lower().replace(' ', '.')}@staff.test",
        "teamId": team_id(client, admin_auth, team), **extra,
    })
    assert response.status_code == 201, response.text
    return response.json()["data"]


def admin_login(client, user):
    from tests.conftest import ADMIN_PASSWORD

    response = client.post("/api/admin/auth/login", json={"email": user.email, "password": ADMIN_PASSWORD})
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


class TestTheCategories:
    def test_the_tree_is_nested_and_comes_from_the_database(self, client, support):
        tree = client.get("/api/support/config").json()["data"]["categories"]
        names = [n["name"] for n in tree]
        assert "Technical / Bug" in names and "Business / Partnership" in names
        payments = next(n for n in tree if n["name"] == "Payments")
        upi = next(n for n in payments["children"] if n["name"] == "UPI Issue")
        assert [i["name"] for i in upi["children"]][0] == "UPI app didn't open"
        # Children inherit routing from the category.
        assert upi["resolved"]["form"] == "payment"

    def test_a_switched_off_branch_disappears(self, client, admin_auth, support):
        from app.models import SupportCategory

        row = support.query(SupportCategory).filter_by(name="Feedback", level=1).one()
        row.active = False
        support.flush()
        names = [n["name"] for n in client.get("/api/support/config").json()["data"]["categories"]]
        assert "Feedback" not in names

    def test_the_path_must_be_real(self, client, support):
        ids = node(client, "Orders", "Order Status")
        other = node(client, "Payments")
        import json

        response = client.post("/api/support/tickets", data={"data": json.dumps({
            "categoryId": other[0], "subcategoryId": ids[1], "description": "Where is my order please?",
            "name": "Asha", "email": "asha@example.com"})})
        assert response.status_code == 422

    def test_a_subcategory_is_required_where_there_are_some(self, client, support):
        import json

        response = client.post("/api/support/tickets", data={"data": json.dumps({
            "categoryId": node(client, "Orders")[0], "description": "Where is my order please?",
            "name": "Asha", "email": "asha@example.com"})})
        assert response.json()["error_code"] == "SUBCATEGORY_REQUIRED"


class TestRaisingATicket:
    def test_routing_numbering_and_priority(self, client, auth, admin_auth, support, outbox):
        connect(client, admin_auth)
        outbox.clear()
        response = raise_ticket(client, auth, "Payments", "Payment Deducted but Order Failed",
                                details={"transactionRef": "UTR123456", "junk": "dropped"})
        assert response.status_code == 201, response.text
        ticket = response.json()["data"]["ticket"]
        assert ticket["number"] == f"DCZ-{datetime.utcnow().year}-000001"
        assert ticket["team"] == "Payments & Finance"
        assert ticket["priority"] == "high"
        assert ticket["status"] == "triaged"  # a team, nobody in it yet
        assert {d["key"] for d in ticket["details"]} == {"transactionRef"}
        assert any("received" in m["subject"].lower() for m in outbox)
        second = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        assert second["number"].endswith("000002")

    def test_the_account_supplies_the_customer(self, client, auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status",
                              name="Someone Else", email="spoof@example.com").json()["data"]["ticket"]
        from app.models import SupportTicket

        row = support.query(SupportTicket).filter_by(number=ticket["number"]).one()
        assert row.email == "shopper@example.com" and row.name == "Asha Rao"

    def test_a_guest_must_give_a_real_email(self, client, support):
        response = raise_ticket(client, None, "General", "General Question", name="Asha", email="nope")
        assert response.json()["error_code"] == "EMAIL_REQUIRED"

    def test_the_honeypot_catches_bots(self, client, support):
        response = raise_ticket(client, None, "General", "General Question", name="Asha",
                                email="asha@example.com", website="http://spam.test")
        assert response.status_code == 422

    def test_only_the_customers_own_order(self, client, auth, support, db, other_customer):
        from tests.integration.test_orders import someone_elses_order

        db.add(someone_elses_order("ORD900", "DCZ19900", other_customer))
        db.flush()
        response = raise_ticket(client, auth, "Orders", "Order Status", orderId="ORD900")
        assert response.status_code == 404

    def test_too_many_in_a_row_are_refused(self, client, support):
        codes = [raise_ticket(client, None, "General", "General Question", name="Asha",
                              email="flood@example.com").status_code for _ in range(6)]
        assert codes[:5] == [201] * 5 and codes[5] == 429

    def test_duplicates_are_found_before_raising_another(self, client, auth, support):
        raise_ticket(client, auth, "Delivery", "Delayed Delivery")
        ids = node(client, "Delivery", "Delayed Delivery")
        found = client.post("/api/support/tickets/duplicates", headers=auth,
                            json={"categoryId": ids[0], "subcategoryId": ids[1]}).json()["data"]
        assert len(found) == 1


class TestAssignment:
    def test_round_robin(self, client, auth, admin_auth, support):
        add_agent(client, admin_auth, "Anil Kumar", "Customer Support")
        add_agent(client, admin_auth, "Bela Shah", "Customer Support")
        owners = [raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]["agent"]
                  for _ in range(3)]
        assert owners == ["Anil Kumar", "Bela Shah", "Anil Kumar"]

    def test_unavailable_agents_are_skipped(self, client, auth, admin_auth, support):
        add_agent(client, admin_auth, "Anil Kumar", "Customer Support", available=False)
        add_agent(client, admin_auth, "Bela Shah", "Customer Support")
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        assert ticket["agent"] == "Bela Shah" and ticket["status"] == "assigned"

    def test_the_customer_may_choose_a_developer_but_never_sees_an_email(self, client, auth, admin_auth, support):
        dev = add_agent(client, admin_auth, "Jane Doe", "Developers", showToCustomers=True,
                        specialization="Backend / API")
        add_agent(client, admin_auth, "Hidden Dev", "Developers", showToCustomers=False)
        ids = node(client, "Technical / Bug", "Checkout Bug")
        options = client.get(f"/api/support/categories/{ids[1]}/handlers").json()["data"]
        assert options["choice"] == "agent"
        people = [a for t in options["teams"] for a in t["agents"]]
        assert [p["name"] for p in people] == ["Jane Doe"]
        assert "email" not in people[0] and "@" not in str(options)
        ticket = raise_ticket(client, auth, "Technical / Bug", "Checkout Bug", agentId=dev["id"],
                              details={"steps": "Tap pay", "browser": "Chrome"}).json()["data"]["ticket"]
        assert ticket["agent"] == "Jane Doe" and ticket["priority"] == "urgent"
        hidden = client.get("/api/admin/support/config", headers=admin_auth).json()["data"]["agents"]
        hidden_id = next(a["id"] for a in hidden if a["name"] == "Hidden Dev")
        refused = raise_ticket(client, auth, "Technical / Bug", "Checkout Bug", agentId=hidden_id)
        assert refused.json()["error_code"] == "INVALID_AGENT"

    def test_staff_are_emailed_from_the_database_not_from_code(self, client, auth, admin_auth, support, outbox):
        connect(client, admin_auth)
        add_agent(client, admin_auth, "Fin Person", "Payments & Finance")
        outbox.clear()
        raise_ticket(client, auth, "Payments", "Payment Failed")
        recipients = {m["to"] for m in outbox}
        assert "fin.person@staff.test" in recipients and "shopper@example.com" in recipients


class TestWhoCanSeeWhat:
    def test_a_guest_needs_the_key(self, client, support):
        data = raise_ticket(client, None, "General", "General Question", name="Guest",
                            email="guest@example.com").json()["data"]
        number, key = data["ticket"]["number"], data["key"]
        assert client.get(f"/api/support/tickets/{number}").status_code == 404
        assert client.get(f"/api/support/tickets/{number}", headers={"X-Ticket-Key": "wrong"}).status_code == 404
        assert client.get(f"/api/support/tickets/{number}", headers={"X-Ticket-Key": key}).status_code == 200

    def test_another_customer_cannot_read_it(self, client, auth, support, other_customer):
        from tests.integration.test_returns import other_customer_auth  # noqa: F401

        number = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]["number"]
        from tests.conftest import PASSWORD

        token = client.post("/api/auth/login", json={"email": other_customer.email, "password": PASSWORD}).json()
        other = {"Authorization": f"Bearer {token['data']['token']['accessToken']}"}
        assert client.get(f"/api/support/tickets/{number}", headers=other).status_code == 404

    def test_internal_notes_and_their_files_stay_internal(self, client, auth, admin_auth, support, stored):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        response = client.post(f"/api/admin/support/tickets/{ticket['id']}/messages", headers=admin_auth,
                               data={"body": "Customer is a VIP", "internal": "true"},
                               files=[("files", ("note.png", PNG, "image/png"))])
        assert response.status_code == 201, response.text
        attachment_id = response.json()["data"]["messages"][-1]["attachments"][0]["id"]
        view = client.get(f"/api/support/tickets/{ticket['number']}", headers=auth).json()["data"]
        assert "VIP" not in str(view["messages"])
        assert "events" not in view
        link = client.get(f"/api/support/tickets/{ticket['number']}/attachments/{attachment_id}", headers=auth)
        assert link.status_code == 404

    def test_an_agent_without_support_sees_only_their_team(self, client, auth, admin_auth, support, editor):
        add_agent(client, admin_auth, "Priya Sharma", "Payments & Finance", adminUserId=editor.id)
        mine = raise_ticket(client, auth, "Payments", "Payment Failed").json()["data"]["ticket"]
        other = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        headers = admin_login(client, editor)
        listed = [t["number"] for t in client.get("/api/admin/support/tickets", headers=headers).json()["data"]]
        assert listed == [mine["number"]]
        assert client.get(f"/api/admin/support/tickets/{other['id']}", headers=headers).status_code == 404

    def test_no_support_role_no_desk(self, client, support, editor):
        headers = admin_login(client, editor)
        assert client.get("/api/admin/support/tickets", headers=headers).status_code == 403

    def test_only_the_super_admin_configures(self, client, support, editor):
        headers = admin_login(client, editor)
        assert client.get("/api/admin/support/config", headers=headers).status_code == 403


class TestTheLifecycle:
    def test_invalid_moves_are_refused(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        response = client.put(f"/api/admin/support/tickets/{ticket['id']}/status", headers=admin_auth,
                              json={"status": "reopened"})
        assert response.json()["error_code"] == "INVALID_TRANSITION"

    def test_reply_resolve_reopen_close(self, client, auth, admin_auth, support, outbox):
        connect(client, admin_auth)
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        outbox.clear()
        reply = client.post(f"/api/admin/support/tickets/{ticket['id']}/messages", headers=admin_auth,
                            data={"body": "It ships tomorrow.", "status": "waiting-customer"})
        assert reply.status_code == 201, reply.text
        staff = reply.json()["data"]
        assert staff["status"] == "waiting-customer" and staff["firstResponseAt"]
        assert any("new reply" in m["subject"].lower() for m in outbox)

        mine = client.get(f"/api/support/tickets/{ticket['number']}", headers=auth).json()["data"]
        assert mine["unread"] == 1 and mine["statusLabel"] == "Waiting for your reply"
        answered = client.post(f"/api/support/tickets/{ticket['number']}/messages", headers=auth,
                               data={"body": "Thanks!"}).json()["data"]
        assert answered["status"] == "in-progress"

        client.put(f"/api/admin/support/tickets/{ticket['id']}/status", headers=admin_auth, json={"status": "resolved"})
        again = client.post(f"/api/support/tickets/{ticket['number']}/messages", headers=auth,
                            data={"body": "Actually it hasn't arrived"}).json()["data"]
        assert again["status"] == "reopened"

        closed = client.post(f"/api/support/tickets/{ticket['number']}/close", headers=auth).json()["data"]
        assert closed["status"] == "closed" and closed["canReopen"]
        refused = client.post(f"/api/support/tickets/{ticket['number']}/messages", headers=auth, data={"body": "hi"})
        assert refused.json()["error_code"] == "TICKET_CLOSED"
        reopened = client.post(f"/api/support/tickets/{ticket['number']}/reopen", headers=auth, json={"reason": ""})
        assert reopened.json()["data"]["status"] == "reopened"

    def test_the_reopen_window_closes(self, client, auth, admin_auth, support, db):
        from app.models import SupportTicket

        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        client.post(f"/api/support/tickets/{ticket['number']}/close", headers=auth)
        row = db.query(SupportTicket).filter_by(number=ticket["number"]).one()
        row.closed_at = datetime.utcnow() - timedelta(days=30)
        db.flush()
        response = client.post(f"/api/support/tickets/{ticket['number']}/reopen", headers=auth, json={})
        assert response.json()["error_code"] == "REOPEN_WINDOW_CLOSED"

    def test_feedback_once_after_resolution(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        path = f"/api/support/tickets/{ticket['number']}/feedback"
        assert client.post(path, headers=auth, json={"rating": 5}).json()["error_code"] == "TICKET_OPEN"
        client.put(f"/api/admin/support/tickets/{ticket['id']}/status", headers=admin_auth, json={"status": "resolved"})
        assert client.post(path, headers=auth, json={"rating": 5, "comment": "Quick!"}).status_code == 200
        assert client.post(path, headers=auth, json={"rating": 4}).json()["error_code"] == "ALREADY_RATED"
        dashboard = client.get("/api/admin/support/dashboard", headers=admin_auth).json()["data"]
        assert dashboard["satisfaction"]["average"] == 5.0

    def test_merging_keeps_both_histories(self, client, auth, admin_auth, support):
        first = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        second = raise_ticket(client, auth, "Orders", "Missing Item",
                              description="Another message about it").json()["data"]["ticket"]
        merged = client.post(f"/api/admin/support/tickets/{second['id']}/merge", headers=admin_auth,
                             json={"other": first["number"]})
        assert merged.status_code == 200, merged.text
        source = client.get(f"/api/admin/support/tickets/{second['id']}", headers=admin_auth).json()["data"]
        assert source["status"] == "closed" and "Another message about it" in str(source["messages"])
        target = merged.json()["data"]
        assert any(link["kind"] == "merged-from" for link in target["links"])
        mine = client.get(f"/api/support/tickets/{second['number']}", headers=auth).json()["data"]
        assert mine["mergedInto"] == first["number"] and not mine["canReply"]

    def test_feature_requests_have_stages(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Feedback", "Feature Request",
                              details={"featureTitle": "Dark mode"}).json()["data"]["ticket"]
        assert ticket["contactType"] == "feature" and ticket["featureStage"] == "requested"
        moved = client.put(f"/api/admin/support/tickets/{ticket['id']}/stage", headers=admin_auth,
                           json={"stage": "planned"})
        assert moved.json()["data"]["featureStage"] == "planned"


class TestAttachments:
    def test_types_are_checked_by_content(self, client, auth, support, stored):
        refused = raise_ticket(client, auth, "Orders", "Order Status",
                               files=[("files", ("photo.png", b"MZ\x90\x00 not an image", "image/png"))])
        assert refused.json()["error_code"] == "FILE_TYPE"
        accepted = raise_ticket(client, auth, "Orders", "Order Status",
                                files=[("files", ("../../etc/photo.png", PNG, "image/png"))])
        assert accepted.status_code == 201, accepted.text
        ticket = accepted.json()["data"]["ticket"]
        attachment = ticket["messages"][0]["attachments"][0]
        assert attachment["name"] == "photo.png"
        assert all(key.startswith("support/") for key in stored)
        link = client.get(f"/api/support/tickets/{ticket['number']}/attachments/{attachment['id']}", headers=auth)
        assert link.json()["data"]["url"].startswith("https://signed.test/support/")

    def test_off_without_storage(self, client, auth, support):
        response = raise_ticket(client, auth, "Orders", "Order Status",
                                files=[("files", ("photo.png", PNG, "image/png"))])
        assert response.json()["error_code"] == "ATTACHMENTS_DISABLED"


class TestTheClock:
    def test_breach_escalates_once(self, client, auth, admin_auth, support, db, outbox):
        from app.models import SupportTicket
        from app.services.support.sla import sweep

        connect(client, admin_auth)
        ticket = raise_ticket(client, auth, "Account", "Account Security").json()["data"]["ticket"]
        assert ticket["priority"] == "urgent"
        row = db.query(SupportTicket).filter_by(number=ticket["number"]).one()
        later = row.resolve_due_at + timedelta(minutes=5)
        outbox.clear()
        assert sweep(db, now=later) >= 1
        db.refresh(row)
        assert row.sla_breached and row.escalation_level >= 1 and row.status == "escalated"
        assert any("breached" in m["subject"].lower() for m in outbox)
        sent = len(outbox)
        sweep(db, now=later)
        assert len(outbox) == sent  # nothing twice

    def test_the_clock_pauses_while_waiting_for_the_customer(self, client, auth, admin_auth, support, db):
        from app.models import SupportTicket
        from app.services.support.sla import sweep

        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        client.post(f"/api/admin/support/tickets/{ticket['id']}/messages", headers=admin_auth,
                    data={"body": "Which address?", "status": "waiting-customer"})
        row = db.query(SupportTicket).filter_by(number=ticket["number"]).one()
        sweep(db, now=row.resolve_due_at + timedelta(hours=1))
        db.refresh(row)
        assert not row.sla_breached

    def test_resolved_tickets_close_themselves(self, client, auth, admin_auth, support, db):
        from app.models import SupportTicket
        from app.services.support.sla import sweep

        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        client.put(f"/api/admin/support/tickets/{ticket['id']}/status", headers=admin_auth, json={"status": "resolved"})
        row = db.query(SupportTicket).filter_by(number=ticket["number"]).one()
        row.resolved_at = datetime.utcnow() - timedelta(days=10)
        db.flush()
        sweep(db)
        db.refresh(row)
        assert row.status == "closed"


class TestConfiguration:
    def test_templates_reject_unknown_variables_and_render_safely(self, client, admin_auth, support):
        bad = client.put("/api/admin/support/config/templates/ticket_created", headers=admin_auth,
                         json={"subject": "Hi {{nope}}", "body": "Body text here"})
        assert bad.json()["error_code"] == "UNKNOWN_VARIABLE"
        from app.services.support.notify import render

        assert render("Hi {{customer_name}}", {"customer_name": "<b>x</b>"}, html=True) == "Hi &lt;b&gt;x&lt;/b&gt;"

    def test_sla_settings_are_validated(self, client, admin_auth, support):
        response = client.put("/api/admin/support/config/settings", headers=admin_auth, json={
            "sla": {p: {"response": 10, "resolve": 5} for p in ("low", "medium", "high", "urgent")}})
        assert response.json()["error_code"] == "INVALID_SLA"

    def test_a_team_in_use_is_switched_off_not_deleted(self, client, auth, admin_auth, support):
        raise_ticket(client, auth, "Orders", "Order Status")
        team = team_id(client, admin_auth, "Customer Support")
        response = client.delete(f"/api/admin/support/config/teams/{team}", headers=admin_auth)
        assert response.json()["error_code"] == "IN_USE"

    def test_customer_notifications(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        client.post(f"/api/admin/support/tickets/{ticket['id']}/messages", headers=admin_auth, data={"body": "Hello"})
        titles = [n["title"] for n in client.get("/api/support/notifications", headers=auth).json()["data"]]
        assert any("New reply" in t for t in titles)


@pytest.fixture()
def store_admin(db):
    """An administrator (not the super admin): works tickets, cannot configure."""
    from app.core.security import hash_password
    from app.models import AdminUser
    from tests.conftest import ADMIN_PASSWORD

    user = AdminUser(
        id="ADM003", email="store.admin@dailychoicezone.com", password_hash=hash_password(ADMIN_PASSWORD),
        name="Store Admin", role="admin", permissions=[], status="active", created_at=datetime(2026, 1, 1),
    )
    db.add(user)
    db.flush()
    return user


def customer_login(client, user):
    from tests.conftest import PASSWORD

    token = client.post("/api/auth/login", json={"email": user.email, "password": PASSWORD}).json()
    return {"Authorization": f"Bearer {token['data']['token']['accessToken']}"}


class TestSecurity:
    def test_ticket_numbers_cannot_be_walked(self, client, auth, admin_auth, support, stored, other_customer):
        ticket = raise_ticket(client, auth, "Orders", "Order Status",
                              files=[("files", ("photo.png", PNG, "image/png"))]).json()["data"]["ticket"]
        number = ticket["number"]
        attachment = ticket["messages"][0]["attachments"][0]["id"]
        client.put(f"/api/admin/support/tickets/{ticket['id']}/status", headers=admin_auth, json={"status": "resolved"})
        other = customer_login(client, other_customer)
        for method, path, kwargs in (
            ("get", f"/api/support/tickets/{number}", {}),
            ("post", f"/api/support/tickets/{number}/messages", {"data": {"body": "hijack"}}),
            ("post", f"/api/support/tickets/{number}/close", {}),
            ("post", f"/api/support/tickets/{number}/reopen", {"json": {"reason": "x"}}),
            ("post", f"/api/support/tickets/{number}/feedback", {"json": {"rating": 1}}),
            ("post", f"/api/support/tickets/{number}/read", {}),
            ("post", f"/api/support/tickets/{number}/typing", {}),
            ("get", f"/api/support/tickets/{number}/attachments/{attachment}", {}),
        ):
            for headers in (other, {}, {"X-Ticket-Key": "guess"}):
                response = getattr(client, method)(path, headers=headers, **kwargs)
                assert response.status_code == 404, (path, headers, response.text)
        # The other customer's list never includes it either.
        assert client.get("/api/support/tickets", headers=other).json()["data"] == []
        # And nothing they tried changed it.
        mine = client.get(f"/api/support/tickets/{number}", headers=auth).json()["data"]
        assert mine["status"] == "resolved" and "hijack" not in str(mine["messages"])

    def test_the_customer_never_sees_a_staff_address(self, client, auth, admin_auth, support):
        add_agent(client, admin_auth, "Anil Kumar", "Customer Support")
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        client.post(f"/api/admin/support/tickets/{ticket['id']}/messages", headers=admin_auth,
                    data={"body": "Checking with the warehouse", "internal": "true"})
        view = client.get(f"/api/support/tickets/{ticket['number']}", headers=auth).json()["data"]
        assert view["agentCard"]["name"] == "Anil Kumar"
        assert "anil.kumar@staff.test" not in str(view) and "warehouse" not in str(view)
        assert "events" not in view and "customerEmail" not in view

    def test_a_guest_replies_with_the_key_only(self, client, support):
        data = raise_ticket(client, None, "General", "General Question", name="Guest",
                            email="guest@example.com").json()["data"]
        number, key = data["ticket"]["number"], data["key"]
        path = f"/api/support/tickets/{number}/messages"
        assert client.post(path, data={"body": "hello"}).status_code == 404
        answered = client.post(path, headers={"X-Ticket-Key": key}, data={"body": "Any news?"})
        assert answered.status_code == 201 and "Any news?" in str(answered.json()["data"]["messages"])

    def test_an_admin_works_tickets_but_does_not_configure(self, client, auth, support, store_admin):
        raise_ticket(client, auth, "Orders", "Order Status")
        headers = admin_login(client, store_admin)
        assert len(client.get("/api/admin/support/tickets", headers=headers).json()["data"]) == 1
        me = client.get("/api/admin/support/me", headers=headers).json()["data"]
        assert me["canWork"] and me["seesEverything"] and not me["canConfigure"]
        assert client.get("/api/admin/support/config", headers=headers).status_code == 403
        assert client.post("/api/admin/support/config/agents", headers=headers,
                           json={"name": "X", "email": "x@staff.test"}).status_code == 403

    def test_a_scoped_agent_cannot_reach_another_team(self, client, auth, admin_auth, support, editor, stored):
        add_agent(client, admin_auth, "Priya Sharma", "Payments & Finance", adminUserId=editor.id)
        mine = raise_ticket(client, auth, "Payments", "Payment Failed").json()["data"]["ticket"]
        other = raise_ticket(client, auth, "Orders", "Order Status",
                             files=[("files", ("photo.png", PNG, "image/png"))]).json()["data"]["ticket"]
        attachment = other["messages"][0]["attachments"][0]["id"]
        headers = admin_login(client, editor)
        base = "/api/admin/support/tickets"
        assert client.get(f"{base}/{other['id']}/attachments/{attachment}", headers=headers).status_code == 404
        assert client.put(f"{base}/{other['id']}/status", headers=headers, json={"status": "resolved"}).status_code == 404
        assert client.post(f"{base}/{other['id']}/messages", headers=headers, data={"body": "x"}).status_code == 404
        assert client.post(f"{base}/{mine['id']}/merge", headers=headers,
                           json={"other": other["number"]}).status_code == 404
        # A filter can't widen what they see.
        listed = client.get(f"{base}?team={team_id(client, admin_auth, 'Customer Support')}", headers=headers)
        assert listed.json()["data"] == []
        dashboard = client.get("/api/admin/support/dashboard", headers=headers).json()["data"]
        assert dashboard["totals"]["total"] == 1


class TestChat:
    def test_no_chat_when_nobody_can_answer(self, client, auth, support):
        import json

        response = client.post("/api/support/chat", headers=auth,
                               data={"data": json.dumps({"description": "Hello there, anyone?"})})
        assert response.status_code == 409 and response.json()["error_code"] == "CHAT_UNAVAILABLE"

    def test_a_chat_is_a_ticket_on_the_chat_channel(self, client, auth, admin_auth, admin, support):
        import json

        client.put("/api/admin/support/config/settings", headers=admin_auth,
                   json={"chat": {"enabled": True, "onlyInBusinessHours": False}})
        add_agent(client, admin_auth, "Live Agent", "Customer Support", adminUserId=admin.id)
        assert client.get("/api/support/config").json()["data"]["chat"]["available"]
        ids = node(client, "Orders", "Order Status")
        response = client.post("/api/support/chat", headers=auth, data={"data": json.dumps({
            "categoryId": ids[0], "subcategoryId": ids[1], "description": "Where is my parcel today?"})})
        assert response.status_code == 201, response.text
        ticket = response.json()["data"]["ticket"]
        assert ticket["channel"] == "chat" and ticket["agent"] == "Live Agent"
        listed = client.get("/api/admin/support/tickets?channel=chat", headers=admin_auth).json()["data"]
        assert [t["number"] for t in listed] == [ticket["number"]]


class TestMoreOfTheLifecycle:
    def test_whoever_answers_an_unassigned_ticket_takes_it(self, client, auth, admin_auth, admin, support):
        add_agent(client, admin_auth, "Deal Maker", "Business & Partnerships", adminUserId=admin.id)
        ticket = raise_ticket(client, auth, "Business / Partnership", "Wholesale",
                              details={"company": "Acme"}).json()["data"]["ticket"]
        assert ticket["agent"] == ""  # the team assigns by hand
        replied = client.post(f"/api/admin/support/tickets/{ticket['id']}/messages", headers=admin_auth,
                              data={"body": "Happy to talk."}).json()["data"]
        assert replied["agent"] == "Deal Maker" and replied["status"] == "in-progress"

    def test_time_spent_waiting_on_the_customer_is_given_back(self, client, auth, admin_auth, support, db):
        from app.models import SupportTicket, TicketEvent

        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        client.post(f"/api/admin/support/tickets/{ticket['id']}/messages", headers=admin_auth,
                    data={"body": "Which address?", "status": "waiting-customer"})
        row = db.query(SupportTicket).filter_by(number=ticket["number"]).one()
        waited = db.query(TicketEvent).filter_by(ticket_id=row.id, kind="status", to_value="waiting-customer").one()
        waited.created_at -= timedelta(hours=3)
        due_before = row.resolve_due_at
        db.flush()
        client.post(f"/api/support/tickets/{ticket['number']}/messages", headers=auth, data={"body": "Home address"})
        db.refresh(row)
        gained = (row.resolve_due_at - due_before).total_seconds() / 3600
        assert 2.9 < gained < 3.1 and row.status == "in-progress"

    def test_least_active_goes_to_whoever_has_least(self, client, auth, admin_auth, support):
        add_agent(client, admin_auth, "Busy Dev", "Technical Support")
        first = raise_ticket(client, auth, "Technical / Bug", "Performance Issue").json()["data"]["ticket"]
        assert first["agent"] == "Busy Dev"
        add_agent(client, admin_auth, "Free Dev", "Technical Support")
        second = raise_ticket(client, auth, "Technical / Bug", "Product Page Bug").json()["data"]["ticket"]
        assert second["agent"] == "Free Dev"

    def test_a_priority_change_moves_the_target(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        before = client.get(f"/api/admin/support/tickets/{ticket['id']}", headers=admin_auth).json()["data"]
        after = client.put(f"/api/admin/support/tickets/{ticket['id']}/priority", headers=admin_auth,
                           json={"priority": "urgent"}).json()["data"]
        assert after["priority"] == "urgent" and after["sla"]["dueAt"] < before["sla"]["dueAt"]
        bad = client.put(f"/api/admin/support/tickets/{ticket['id']}/priority", headers=admin_auth,
                         json={"priority": "whenever"})
        assert bad.json()["error_code"] == "INVALID_PRIORITY"
        assert any(e["kind"] == "priority" for e in after["events"])

    def test_escalating_by_hand(self, client, auth, admin_auth, support):
        add_agent(client, admin_auth, "Team Lead", "Customer Support", isLead=True)
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        path = f"/api/admin/support/tickets/{ticket['id']}/escalate"
        assert client.post(path, headers=admin_auth, json={"reason": ""}).json()["error_code"] == "REASON_REQUIRED"
        escalated = client.post(path, headers=admin_auth,
                                json={"reason": "Customer is waiting too long"}).json()["data"]
        assert escalated["status"] == "escalated" and escalated["escalationLevel"] == 1

    def test_linking_and_unlinking(self, client, auth, admin_auth, support):
        first = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        second = raise_ticket(client, auth, "Delivery", "Delayed Delivery").json()["data"]["ticket"]
        linked = client.post(f"/api/admin/support/tickets/{first['id']}/links", headers=admin_auth,
                             json={"other": second["number"]}).json()["data"]
        assert [link["number"] for link in linked["links"]] == [second["number"]]
        same = client.post(f"/api/admin/support/tickets/{first['id']}/links", headers=admin_auth,
                           json={"other": first["number"]})
        assert same.json()["error_code"] == "SAME_TICKET"
        unlinked = client.delete(f"/api/admin/support/tickets/{first['id']}/links/{second['id']}",
                                 headers=admin_auth).json()["data"]
        assert unlinked["links"] == []

    def test_the_sweep_reaches_every_open_ticket(self, client, auth, support, db, monkeypatch):
        from app.models import SupportTicket
        from app.services.support import sla

        monkeypatch.setattr(sla, "BATCH", 2)
        numbers = [raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]["number"]
                   for _ in range(5)]
        latest = max(r.resolve_due_at for r in db.query(SupportTicket).all())
        sla.sweep(db, now=latest + timedelta(minutes=1))
        rows = db.query(SupportTicket).filter(SupportTicket.number.in_(numbers)).all()
        assert all(r.sla_breached for r in rows)

    def test_a_fresh_store_has_no_people_and_no_addresses(self, client, admin_auth, support):
        data = client.get("/api/admin/support/config", headers=admin_auth).json()["data"]
        assert data["agents"] == []
        assert all(t["notifyEmail"] == "" for t in data["teams"])

    def test_a_branch_can_switch_off_the_choice_its_parent_offers(self, client, admin_auth, support):
        ids = node(client, "Technical / Bug", "Checkout Bug")
        assert client.get(f"/api/support/categories/{ids[1]}/handlers").json()["data"]["choice"] == "agent"
        saved = client.put(f"/api/admin/support/config/categories/{ids[1]}", headers=admin_auth,
                           json={"name": "Checkout Bug", "customerChoice": "none", "priority": "urgent"})
        assert saved.status_code == 200, saved.text
        assert client.get(f"/api/support/categories/{ids[1]}/handlers").json()["data"]["choice"] == ""
        # The rest of the branch still offers it.
        other = node(client, "Technical / Bug", "Website Bug")
        assert client.get(f"/api/support/categories/{other[1]}/handlers").json()["data"]["choice"] == "agent"

    def test_tickets_from_another_customer_cannot_be_merged(self, client, auth, admin_auth, support, other_customer):
        mine = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        theirs = raise_ticket(client, customer_login(client, other_customer), "Orders",
                              "Order Status").json()["data"]["ticket"]
        response = client.post(f"/api/admin/support/tickets/{mine['id']}/merge", headers=admin_auth,
                               json={"other": theirs["number"]})
        assert response.json()["error_code"] == "DIFFERENT_CUSTOMER"
