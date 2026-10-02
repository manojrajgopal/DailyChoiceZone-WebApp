"""
Ticket behaviour beyond the happy paths in test_support.py: every refusal
when raising a ticket, the status table, assignment and reassignment, the
conversation's edge cases, merging and linking, reading and typing, the
customer's own list and the support desk's filters.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest

from tests.integration.test_email import outbox  # noqa: F401 -- fixture
from tests.integration.test_support import (  # noqa: F401 -- fixtures
    PNG,
    _fresh_limits,
    add_agent,
    admin_login,
    customer_login,
    node,
    raise_ticket,
    stored,
    support,
    team_id,
)

pytestmark = pytest.mark.integration

DESK = "/api/admin/support/tickets"


@pytest.fixture(autouse=True)
def _no_mail(outbox):  # noqa: F811
    return outbox


def error(response, status, code):
    assert response.status_code == status, response.text
    body = response.json()
    assert body["success"] is False and body["error_code"] == code, body
    return body


def post_raw(client, payload, headers=None, files=None):
    return client.post("/api/support/tickets", headers=headers or {},
                       data={"data": json.dumps(payload)}, files=files or [])


def ticket_row(db, number):
    from app.models import SupportTicket

    db.expire_all()
    return db.query(SupportTicket).filter_by(number=number).one()


def staff(client, admin_auth, ticket_id):
    response = client.get(f"{DESK}/{ticket_id}", headers=admin_auth)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def set_status(client, admin_auth, ticket_id, status):
    return client.put(f"{DESK}/{ticket_id}/status", headers=admin_auth, json={"status": status})


def guest_ticket(client, email="guest@example.com", name="Guest Person"):
    data = raise_ticket(client, None, "General", "General Question", name=name, email=email).json()["data"]
    return data["ticket"], {"X-Ticket-Key": data["key"]}


@pytest.fixture()
def own_order(db, customer):
    from tests.integration.test_orders import someone_elses_order

    order = someone_elses_order("ORD901", "DCZ19901", customer)
    db.add(order)
    db.flush()
    return order


# ------------------------------------------------------------- raising one


class TestRaisingRefusals:
    def test_a_category_is_required_outside_chat(self, client, auth, support):
        error(post_raw(client, {"description": "Something is not right here."}, auth), 422, "CATEGORY_REQUIRED")

    def test_an_issue_is_required_where_the_option_has_some(self, client, auth, support):
        error(raise_ticket(client, auth, "Payments", "UPI Issue"), 422, "ISSUE_REQUIRED")

    @pytest.mark.parametrize("fields, code", [
        ({"name": "A", "email": "a@example.com"}, "NAME_REQUIRED"),
        ({"name": "Asha", "email": "a@example.com", "phone": "12345"}, "INVALID_PHONE"),
        ({"name": "Asha", "email": "a@example.com", "description": "short"}, "DESCRIPTION_TOO_SHORT"),
        ({"name": "Asha", "email": "a@example.com", "description": "x" * 5001}, "DESCRIPTION_TOO_LONG"),
        ({"name": "Asha", "email": "a@example.com", "productId": "PRD999"}, "PRODUCT_NOT_FOUND"),
        ({"name": "Asha", "email": "a@example.com", "orderId": "ORD901"}, "ORDER_NOT_FOUND"),
    ])
    def test_guest_refusals(self, client, support, fields, code):
        response = raise_ticket(client, None, "General", "General Question", **fields)
        assert response.status_code in (404, 422)
        assert response.json()["error_code"] == code

    @pytest.mark.parametrize("data", ["{not json", "[1, 2]", "\"text\""])
    def test_an_unreadable_payload(self, client, support, data):
        error(client.post("/api/support/tickets", data={"data": data}), 422, "INVALID_PAYLOAD")

    def test_nothing_is_written_when_refused(self, client, auth, support, db):
        from app.models import SupportTicket

        raise_ticket(client, auth, "Orders", "Order Status", description="tiny")
        assert db.query(SupportTicket).count() == 0

    def test_a_guest_phone_is_kept_as_ten_digits(self, client, support, db):
        ticket, _ = guest_ticket(client)
        assert ticket_row(db, ticket["number"]).phone == ""
        data = raise_ticket(client, None, "General", "General Question", name="Asha",
                            email="phone@example.com", phone="+91 98765-43210").json()["data"]
        assert ticket_row(db, data["ticket"]["number"]).phone == "9876543210"


class TestWhatATicketIsAbout:
    def test_the_customers_own_order_and_a_product(self, client, auth, admin_auth, support, catalogue, own_order,
                                                   db):
        from app.models import ProductImage

        db.add(ProductImage(product_id="PRD001", url="https://img.example.com/kurta.jpg", position=0))
        db.flush()
        response = raise_ticket(client, auth, "Products", "Product Information", orderId="ORD901",
                                productId="PRD001")
        assert response.status_code == 201, response.text
        mine = response.json()["data"]["ticket"]
        assert mine["orderNumber"] == "DCZ19901"
        assert mine["order"]["number"] == "DCZ19901" and mine["order"]["items"] == []
        assert mine["product"] == {"id": "PRD001", "name": "Cotton Kurta", "brand": "Anvi", "slug": "cotton-kurta",
                                   "image": "https://img.example.com/kurta.jpg", "price": 1000.0}
        view = staff(client, admin_auth, mine["id"])
        assert view["customer"]["orders"] == 1 and view["customer"]["email"] == "shopper@example.com"

    def test_an_order_number_typed_into_the_form_shows_when_no_order_is_linked(self, client, auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status",
                              details={"orderNumber": "DCZ55555"}).json()["data"]["ticket"]
        assert ticket["orderNumber"] == "DCZ55555" and ticket["order"] is None and ticket["product"] is None

    def test_a_membership_question_carries_the_active_membership(self, client, auth, admin_auth, support, customer,
                                                                db):
        from app.models import CustomerMembership, MembershipPlan

        now = datetime.utcnow()
        db.add(MembershipPlan(id="MPL001", name="Choice Circle", duration_months=12, price=999,
                              created_at=now, updated_at=now))
        db.flush()
        db.add(CustomerMembership(id="MEM001", customer_id=customer.id, plan_id="MPL001", plan_name="Choice Circle",
                                  duration_months=12, status="active", starts_at=now - timedelta(days=1),
                                  ends_at=now + timedelta(days=300), amount=99900, benefits={},
                                  created_at=now, updated_at=now))
        db.flush()
        ticket = raise_ticket(client, auth, "Membership", "Membership Information").json()["data"]["ticket"]
        view = staff(client, admin_auth, ticket["id"])
        assert view["membership"]["id"] == "MEM001" and view["membership"]["plan"] == "Choice Circle"
        listed = client.get(f"{DESK}?membership=1", headers=admin_auth).json()["data"]
        assert [t["number"] for t in listed] == [ticket["number"]]

    def test_a_guest_has_no_customer_record_on_the_desk(self, client, admin_auth, support):
        ticket, _ = guest_ticket(client)
        view = staff(client, admin_auth, ticket["id"])
        assert view["customer"]["guest"] is True and view["customer"]["id"] is None
        assert view["customer"]["email"] == "guest@example.com"


class TestRoutingOnCreation:
    def test_a_switched_off_team_falls_back_to_the_default_team(self, client, auth, admin_auth, support, db):
        from app.models import SupportTeam

        db.get(SupportTeam, team_id(client, admin_auth, "Payments & Finance")).active = False
        db.flush()
        ticket = raise_ticket(client, auth, "Payments", "Payment Failed").json()["data"]["ticket"]
        assert ticket["team"] == "Customer Support"

    def test_the_customer_may_pick_a_team_that_is_offered_and_no_other(self, client, auth, admin_auth, support):
        developers = team_id(client, admin_auth, "Developers")
        ticket = raise_ticket(client, auth, "Technical / Bug", "Checkout Bug", teamId=developers).json()
        assert ticket["data"]["ticket"]["team"] == "Developers"
        view = staff(client, admin_auth, ticket["data"]["ticket"]["id"])
        assert any(e["kind"] == "customer-choice" and e["to"] == "Developers" for e in view["events"])
        error(raise_ticket(client, auth, "Technical / Bug", "Checkout Bug",
                           teamId=team_id(client, admin_auth, "Customer Support")), 422, "INVALID_TEAM")

    def test_a_bug_report_records_the_browser(self, client, auth, support):
        ticket = client.post("/api/support/tickets", headers={**auth, "User-Agent": "TestBrowser/1.0"}, data={
            "data": json.dumps({"categoryId": node(client, "Technical / Bug")[0],
                                "subcategoryId": node(client, "Technical / Bug", "Checkout Bug")[1],
                                "description": "The pay button does nothing."})}).json()["data"]["ticket"]
        assert {"key": "userAgent", "label": "User agent", "value": "TestBrowser/1.0"} in ticket["details"]

    def test_a_guest_chat_needs_no_category(self, client, admin_auth, admin, support):
        client.put("/api/admin/support/config/settings", headers=admin_auth,
                   json={"chat": {"enabled": True, "onlyInBusinessHours": False}})
        add_agent(client, admin_auth, "Live Agent", "Customer Support", adminUserId=admin.id)
        response = client.post("/api/support/chat", data={"data": json.dumps({
            "description": "Hello, is anyone there?", "name": "Chatty", "email": "chatty@example.com"})})
        assert response.status_code == 201, response.text
        data = response.json()["data"]
        assert data["key"] and data["ticket"]["category"] == "Live chat" and data["ticket"]["subject"] == "Live chat"
        assert data["chat"]["available"] is True


# ---------------------------------------------------------------- duplicates


class TestDuplicates:
    def test_matching_by_issue_category_and_order(self, client, auth, support, own_order):
        ids = node(client, "Payments", "UPI Issue", "UPI app didn't open")
        raise_ticket(client, auth, "Payments", "UPI Issue", "UPI app didn't open")
        raise_ticket(client, auth, "Payments", "Payment Failed", orderId="ORD901")

        def found(**payload):
            response = client.post("/api/support/tickets/duplicates", headers=auth, json=payload)
            assert response.status_code == 200
            return response.json()["data"]

        assert len(found(issueId=ids[2])) == 1
        assert len(found(categoryId=ids[0])) == 2
        assert len(found(categoryId=ids[0], orderId="ORD901")) == 2  # tickets without an order still count
        assert len(found(categoryId=ids[0], orderId="ORD-OTHER")) == 1
        assert found() == []

    def test_only_signed_in_customers(self, client, support):
        assert client.post("/api/support/tickets/duplicates", json={"categoryId": 1}).status_code == 401


# ------------------------------------------------------------ the status table


TABLE_CASES = [(src, dst) for src in ("submitted", "triaged", "assigned", "acknowledged", "in-progress",
                                      "waiting-customer", "waiting-internal", "escalated", "resolved",
                                      "closed", "reopened")
               for dst in ("submitted", "triaged", "assigned", "acknowledged", "in-progress", "waiting-customer",
                           "waiting-internal", "escalated", "resolved", "closed", "reopened")
               if src != dst]


class TestTheStatusTable:
    @pytest.mark.parametrize("src, dst", TABLE_CASES)
    def test_every_move_outside_the_table_is_refused(self, src, dst):
        from app.core.errors import ConflictError
        from app.models import SupportTicket
        from app.services.support import tickets

        ticket = SupportTicket(status=src, merged_into_id=None)
        if dst in tickets.TRANSITIONS[src]:
            assert dst in tickets.transitions_for(ticket)
            return
        with pytest.raises(ConflictError) as caught:
            tickets.set_status(None, ticket, dst, tickets.SYSTEM)
        assert caught.value.error_code == "INVALID_TRANSITION"
        assert ticket.status == src

    def test_nothing_moves_to_submitted_and_closed_only_reopens(self):
        from app.services.support import tickets

        assert all("submitted" not in moves for moves in tickets.TRANSITIONS.values())
        assert tickets.TRANSITIONS["closed"] == ("reopened",)
        assert set(tickets.TRANSITIONS) == set(tickets.STATUSES)

    def test_an_unknown_status_and_the_same_status(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        error(set_status(client, admin_auth, ticket["id"], "lost"), 422, "INVALID_STATUS")
        before = len(staff(client, admin_auth, ticket["id"])["events"])
        same = set_status(client, admin_auth, ticket["id"], "triaged")
        assert same.status_code == 200 and len(same.json()["data"]["events"]) == before

    def test_staff_walk_a_ticket_through_and_the_customer_hears_each_step(self, client, auth, admin_auth, support,
                                                                         db):
        from app.models import CustomerNotification

        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        for status in ("in-progress", "waiting-internal", "escalated", "resolved", "closed"):
            response = set_status(client, admin_auth, ticket["id"], status)
            assert response.status_code == 200, response.text
            assert response.json()["data"]["status"] == status
        kinds = [n.kind for n in db.query(CustomerNotification).filter_by(customer_id="CUS001").all()]
        assert kinds.count("status_changed") == 3
        assert "ticket_resolved" in kinds and "ticket_closed" in kinds

        row = ticket_row(db, ticket["number"])
        assert row.resolved_at is not None and row.closed_at is not None
        reopened = set_status(client, admin_auth, ticket["id"], "reopened")
        assert reopened.status_code == 200
        row = ticket_row(db, ticket["number"])
        assert row.status == "reopened" and row.reopened_count == 1
        assert row.resolved_at is None and row.closed_at is None and row.resolve_due_at > datetime.utcnow()
        assert "ticket_reopened" in [n.kind for n in db.query(CustomerNotification).all()]
        transitions = [t["value"] for t in reopened.json()["data"]["transitions"]]
        assert transitions == ["assigned", "in-progress", "waiting-customer", "waiting-internal", "escalated",
                               "resolved"]

    def test_a_merged_ticket_cannot_be_moved(self, client, auth, admin_auth, support):
        first = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        second = raise_ticket(client, auth, "Orders", "Missing Item").json()["data"]["ticket"]
        client.post(f"{DESK}/{second['id']}/merge", headers=admin_auth, json={"other": first["number"]})
        error(set_status(client, admin_auth, second["id"], "reopened"), 409, "TICKET_MERGED")


# ---------------------------------------------------------------- assignment


class TestAssignmentByHand:
    def test_assign_reassign_and_move_team(self, client, auth, admin_auth, admin, support, db):
        from app.models import Notification

        anil = add_agent(client, admin_auth, "Anil Kumar", "Customer Support", adminUserId=admin.id)
        bela = add_agent(client, admin_auth, "Bela Shah", "Payments & Finance")
        client.put(f"/api/admin/support/config/agents/{anil['id']}", headers=admin_auth, json={
            "name": "Anil Kumar", "email": anil["email"], "teamId": anil["teamId"], "adminUserId": admin.id,
            "available": False})
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        assert ticket["agent"] == "" and ticket["status"] == "triaged"
        path = f"{DESK}/{ticket['id']}/assignment"

        # By agent alone: the team follows the agent. The admin assigning themselves is not notified.
        trays = db.query(Notification).filter_by(admin_id=admin.id).count()
        assigned = client.put(path, headers=admin_auth, json={"agentId": anil["id"]})
        assert assigned.status_code == 200, assigned.text
        data = assigned.json()["data"]
        assert data["agent"] == "Anil Kumar" and data["team"] == "Customer Support" and data["status"] == "assigned"
        assert data["agentCard"]["email"] == anil["email"]
        assert db.query(Notification).filter_by(admin_id=admin.id).count() == trays
        assert any(e["kind"] == "assigned" and e["to"] == "Anil Kumar" for e in data["events"])

        # The same again changes nothing.
        same = client.put(path, headers=admin_auth, json={"agentId": anil["id"]}).json()["data"]
        assert len(same["events"]) == len(data["events"])

        moved = client.put(path, headers=admin_auth, json={"agentId": bela["id"]}).json()["data"]
        assert moved["agent"] == "Bela Shah" and moved["team"] == "Payments & Finance"
        assert any(e["kind"] == "reassigned" and e["from"] == "Anil Kumar" for e in moved["events"])
        assert any(e["kind"] == "team" and e["to"] == "Payments & Finance" for e in moved["events"])

        team_only = client.put(path, headers=admin_auth,
                               json={"teamId": team_id(client, admin_auth, "Delivery & Operations")}).json()["data"]
        assert team_only["agent"] == "" and team_only["team"] == "Delivery & Operations"
        assert any(e["kind"] == "reassigned" and e["to"] == "Unassigned" for e in team_only["events"])
        assert "Your request is with our Delivery & Operations team." in str(team_only["messages"])
        # A ticket already assigned keeps its place in the lifecycle when it moves team.
        assert team_only["status"] == "assigned"

    def test_refusals(self, client, auth, admin_auth, support, db):
        from app.models import SupportTeam

        gone = add_agent(client, admin_auth, "Gone Agent", "Customer Support", active=False)
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        path = f"{DESK}/{ticket['id']}/assignment"
        error(client.put(path, headers=admin_auth, json={"teamId": 999999}), 422, "TEAM_NOT_FOUND")
        error(client.put(path, headers=admin_auth, json={"agentId": gone["id"]}), 422, "AGENT_NOT_FOUND")
        error(client.put(path, headers=admin_auth, json={"agentId": 999999}), 422, "AGENT_NOT_FOUND")
        off = team_id(client, admin_auth, "Product Team")
        db.get(SupportTeam, off).active = False
        db.flush()
        error(client.put(path, headers=admin_auth, json={"teamId": off}), 422, "TEAM_NOT_FOUND")
        error(client.put(f"{DESK}/NOPE/assignment", headers=admin_auth, json={}), 404, "TICKET_NOT_FOUND")

    def test_a_submitted_ticket_given_a_team_is_triaged(self, support, db):
        from app.models import SupportTeam, SupportTicket
        from app.services.support import tickets

        team = db.query(SupportTeam).filter_by(name="Customer Support").one()
        ticket = SupportTicket(status="submitted", team_id=None, agent_id=None, number="T-1", id="X1",
                               description="", subject="")
        tickets.assign(db, ticket, team_id=team.id, agent_id=None, actor=tickets.SYSTEM, notify_people=False)
        assert ticket.status == "triaged" and ticket.team_id == team.id


# ------------------------------------------------------- priority and stage


class TestPriorityAndStage:
    def test_the_same_priority_changes_nothing_and_a_lower_one_moves_only_open_targets(
            self, client, auth, admin_auth, support, db):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        path = f"{DESK}/{ticket['id']}/priority"
        before = staff(client, admin_auth, ticket["id"])
        same = client.put(path, headers=admin_auth, json={"priority": "medium"}).json()["data"]
        assert len(same["events"]) == len(before["events"])

        client.post(f"{DESK}/{ticket['id']}/messages", headers=admin_auth, data={"body": "On it."})
        row = ticket_row(db, ticket["number"])
        response_due, resolve_due = row.response_due_at, row.resolve_due_at
        client.put(path, headers=admin_auth, json={"priority": "low"})
        row = ticket_row(db, ticket["number"])
        # Answered already: the first-reply target stays; resolution moves by low minus medium (48 - 24).
        assert row.response_due_at == response_due
        assert abs((row.resolve_due_at - resolve_due).total_seconds() - 24 * 3600) < 2

        set_status(client, admin_auth, ticket["id"], "resolved")
        row = ticket_row(db, ticket["number"])
        done_due = row.resolve_due_at
        client.put(path, headers=admin_auth, json={"priority": "urgent"})
        assert ticket_row(db, ticket["number"]).resolve_due_at == done_due

    def test_raising_to_high_tells_the_team_lead(self, client, auth, admin_auth, admin, support, db):
        from app.models import Notification

        add_agent(client, admin_auth, "Lead Person", "Customer Support", isLead=True, adminUserId=admin.id)
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        before = db.query(Notification).filter_by(admin_id=admin.id).count()
        client.put(f"{DESK}/{ticket['id']}/priority", headers=admin_auth, json={"priority": "high"})
        titles = [n.title for n in db.query(Notification).filter_by(admin_id=admin.id).all()]
        assert len(titles) == before + 1 and any(t.endswith("is now high") for t in titles)

    def test_a_breached_ticket_stays_breached_when_the_new_target_is_already_past(self, client, auth, admin_auth,
                                                                                   support, db):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        row = ticket_row(db, ticket["number"])
        row.resolve_due_at = datetime.utcnow() - timedelta(hours=30)
        row.sla_breached = True
        db.flush()
        client.put(f"{DESK}/{ticket['id']}/priority", headers=admin_auth, json={"priority": "urgent"})
        assert ticket_row(db, ticket["number"]).sla_breached is True

    def test_stages_are_for_feature_requests_only(self, client, auth, admin_auth, support):
        plain = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        error(client.put(f"{DESK}/{plain['id']}/stage", headers=admin_auth, json={"stage": "planned"}), 409,
              "NOT_A_FEATURE_REQUEST")
        feature = raise_ticket(client, auth, "Feedback", "Feature Request").json()["data"]["ticket"]
        path = f"{DESK}/{feature['id']}/stage"
        error(client.put(path, headers=admin_auth, json={"stage": "someday"}), 422, "INVALID_STAGE")
        before = staff(client, admin_auth, feature["id"])
        same = client.put(path, headers=admin_auth, json={"stage": "requested"}).json()["data"]
        assert len(same["events"]) == len(before["events"])
        mine = client.get(f"/api/support/tickets/{feature['number']}", headers=auth).json()["data"]
        assert mine["featureStageLabel"] == "Requested"


# -------------------------------------------------------------- conversation


class TestTheConversation:
    def test_customer_refusals(self, client, auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        path = f"/api/support/tickets/{ticket['number']}/messages"
        error(client.post(path, headers=auth, data={"body": "   "}), 422, "EMPTY_MESSAGE")
        error(client.post(path, headers=auth, data={"body": "x" * 5001}), 422, "MESSAGE_TOO_LONG")

    def test_a_merged_request_points_to_where_it_continues(self, client, auth, admin_auth, support):
        first = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        second = raise_ticket(client, auth, "Orders", "Missing Item").json()["data"]["ticket"]
        client.post(f"{DESK}/{second['id']}/merge", headers=admin_auth, json={"other": first["number"]})
        body = error(client.post(f"/api/support/tickets/{second['number']}/messages", headers=auth,
                                 data={"body": "Hello?"}), 409, "TICKET_MERGED")
        assert first["number"] in body["message"]
        error(client.post(f"{DESK}/{second['id']}/messages", headers=admin_auth, data={"body": "x"}), 409,
              "TICKET_MERGED")
        error(client.post(f"/api/support/tickets/{second['number']}/reopen", headers=auth, json={}), 409,
              "TICKET_MERGED")

    def test_staff_refusals(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        path = f"{DESK}/{ticket['id']}/messages"
        error(client.post(path, headers=admin_auth, data={"body": ""}), 422, "EMPTY_MESSAGE")
        error(client.post(path, headers=admin_auth, data={"body": "x" * 10001}), 422, "MESSAGE_TOO_LONG")
        error(client.post(path, headers=admin_auth, data={"body": "Hi", "status": "lost"}), 422, "INVALID_STATUS")
        set_status(client, admin_auth, ticket["id"], "closed")
        error(client.post(path, headers=admin_auth, data={"body": "Hello again"}), 409, "TICKET_CLOSED")
        note = client.post(path, headers=admin_auth, data={"body": "Closed; noting for later", "internal": "true"})
        assert note.status_code == 201 and note.json()["data"]["messages"][-1]["kind"] == "note"

    def test_a_reply_asking_for_a_status_from_the_table(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        replied = client.post(f"{DESK}/{ticket['id']}/messages", headers=admin_auth,
                              data={"body": "Fixed it.", "status": "resolved"}).json()["data"]
        assert replied["status"] == "resolved" and replied["resolvedAt"]
        # Asking for the status it already has is a no-op.
        again = client.post(f"{DESK}/{ticket['id']}/messages", headers=admin_auth,
                            data={"body": "One more thing.", "status": "resolved"}).json()["data"]
        assert again["status"] == "resolved"

    def test_customer_files_ride_on_their_reply(self, client, auth, support, stored):  # noqa: F811
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        response = client.post(f"/api/support/tickets/{ticket['number']}/messages", headers=auth,
                               data={"body": ""}, files=[("files", ("receipt.png", PNG, "image/png"))])
        assert response.status_code == 201, response.text
        last = [m for m in response.json()["data"]["messages"] if m["kind"] == "customer"][-1]
        assert last["attachments"][0]["name"] == "receipt.png" and len(stored) == 1
        assert response.json()["data"]["lastMessage"] == "Sent a file"

    def test_an_oversized_file_is_refused_before_it_is_read(self, client, auth, admin_auth, support):
        client.put("/api/admin/support/config/settings", headers=admin_auth,
                   json={"attachments": {"maxFiles": 5, "maxSizeMb": 1, "maxVideoSizeMb": 1}})
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        big = PNG + bytes(1024 * 1024)
        error(client.post(f"/api/support/tickets/{ticket['number']}/messages", headers=auth, data={"body": "x"},
                          files=[("files", ("../big.png", big, "image/png"))]), 422, "FILE_TOO_LARGE")

    def test_an_upload_without_a_name_is_skipped(self, support, db):
        import asyncio
        from io import BytesIO

        from fastapi import UploadFile

        from app.api.routes.support import _read

        uploads = [UploadFile(file=BytesIO(b"abc"), filename=""), UploadFile(file=BytesIO(b"xyz"), filename="a.txt")]
        assert asyncio.run(_read(uploads, db)) == [("a.txt", b"xyz")]
        assert asyncio.run(_read(None, db)) == []


# ------------------------------------------------------- reading and typing


class TestReadingAndTyping:
    def test_the_customer_reads_and_their_bell_clears(self, client, auth, admin_auth, support, db):
        from app.models import CustomerNotification

        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        client.post(f"{DESK}/{ticket['id']}/messages", headers=admin_auth, data={"body": "Hello"})
        assert client.get(f"/api/support/tickets/{ticket['number']}", headers=auth).json()["data"]["unread"] == 1
        assert client.post(f"/api/support/tickets/{ticket['number']}/read", headers=auth).status_code == 200
        assert client.get(f"/api/support/tickets/{ticket['number']}", headers=auth).json()["data"]["unread"] == 0
        db.expire_all()
        mine = db.query(CustomerNotification).filter_by(customer_id="CUS001").all()
        assert mine and all(n.read for n in mine if n.href.endswith(ticket["number"]))

    def test_a_guest_reads_with_the_key(self, client, admin_auth, support, db):
        ticket, key = guest_ticket(client)
        client.post(f"{DESK}/{ticket['id']}/messages", headers=admin_auth, data={"body": "Hello guest"})
        assert client.post(f"/api/support/tickets/{ticket['number']}/read", headers=key).status_code == 200
        assert ticket_row(db, ticket["number"]).customer_unread == 0

    def test_each_side_sees_the_other_typing(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        assert staff(client, admin_auth, ticket["id"])["customerTyping"] is False
        assert client.post(f"/api/support/tickets/{ticket['number']}/typing", headers=auth).status_code == 200
        assert staff(client, admin_auth, ticket["id"])["customerTyping"] is True
        assert client.post(f"{DESK}/{ticket['id']}/typing", headers=admin_auth).status_code == 200
        assert client.get(f"/api/support/tickets/{ticket['number']}", headers=auth).json()["data"]["agentTyping"]

    def test_staff_reading_clears_their_count(self, client, auth, admin_auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        assert staff(client, admin_auth, ticket["id"])["unread"] == 1
        assert client.post(f"{DESK}/{ticket['id']}/read", headers=admin_auth).status_code == 200
        assert staff(client, admin_auth, ticket["id"])["unread"] == 0

    def test_every_notification_can_be_marked_read(self, client, auth, admin_auth, support, db):
        from app.models import CustomerNotification

        for _ in range(2):
            ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
            client.post(f"{DESK}/{ticket['id']}/messages", headers=admin_auth, data={"body": "Hello"})
        listed = client.get("/api/support/notifications", headers=auth).json()["data"]
        assert listed and not any(n["read"] for n in listed)
        assert client.post("/api/support/notifications/read", headers=auth).status_code == 200
        assert all(n["read"] for n in client.get("/api/support/notifications", headers=auth).json()["data"])
        assert client.post("/api/support/notifications/read").status_code == 401


# --------------------------------------------------- closing, reopening, rating


class TestCustomerActions:
    def test_closing_twice_is_harmless(self, client, auth, support, db):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        path = f"/api/support/tickets/{ticket['number']}/close"
        assert client.post(path, headers=auth).json()["data"]["status"] == "closed"
        closed_at = ticket_row(db, ticket["number"]).closed_at
        again = client.post(path, headers=auth)
        assert again.status_code == 200 and again.json()["data"]["status"] == "closed"
        assert ticket_row(db, ticket["number"]).closed_at == closed_at

    def test_an_open_request_cannot_be_reopened(self, client, auth, support):
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        error(client.post(f"/api/support/tickets/{ticket['number']}/reopen", headers=auth, json={}), 409,
              "TICKET_OPEN")

    def test_a_guest_closes_and_reopens_with_the_key(self, client, support, db):
        ticket, key = guest_ticket(client)
        assert client.post(f"/api/support/tickets/{ticket['number']}/close", headers=key).status_code == 200
        reopened = client.post(f"/api/support/tickets/{ticket['number']}/reopen", headers=key,
                               json={"reason": "  Still broken  "})
        assert reopened.status_code == 200 and reopened.json()["data"]["status"] == "reopened"
        row = ticket_row(db, ticket["number"])
        assert any(e.kind == "status" and e.note == "Still broken" for e in row.events)

    def test_ratings_must_be_one_to_five(self, client, auth, admin_auth, support, db):
        from app.core.errors import ValidationError
        from app.services.support import tickets

        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        set_status(client, admin_auth, ticket["id"], "resolved")
        path = f"/api/support/tickets/{ticket['number']}/feedback"
        error(client.post(path, headers=auth, json={"rating": 0}), 422, "INVALID_RATING")
        error(client.post(path, headers=auth, json={"rating": 6}), 422, "INVALID_RATING")
        with pytest.raises(ValidationError) as caught:
            tickets.feedback(db, ticket_row(db, ticket["number"]), "five", "")
        assert caught.value.error_code == "INVALID_RATING"
        rated = client.post(path, headers=auth, json={"rating": 4, "comment": "  Fine  "}).json()["data"]
        assert rated["feedback"] == {"rating": 4, "comment": "Fine"} and rated["canRate"] is False
        assert staff(client, admin_auth, ticket["id"])["feedback"]["rating"] == 4


# ----------------------------------------------------------- merge and link


class TestMergeAndLink:
    def test_merge_refusals(self, client, auth, admin_auth, support):
        a = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        b = raise_ticket(client, auth, "Orders", "Missing Item").json()["data"]["ticket"]
        c = raise_ticket(client, auth, "Orders", "Wrong Item").json()["data"]["ticket"]
        error(client.post(f"{DESK}/{a['id']}/merge", headers=admin_auth, json={"other": a["number"]}), 422,
              "SAME_TICKET")
        error(client.post(f"{DESK}/{a['id']}/merge", headers=admin_auth, json={"other": "DCZ-1999-000001"}), 404,
              "TICKET_NOT_FOUND")
        assert client.post(f"{DESK}/{b['id']}/merge", headers=admin_auth, json={"other": a["id"]}).status_code == 200
        error(client.post(f"{DESK}/{c['id']}/merge", headers=admin_auth, json={"other": b["number"]}), 409,
              "ALREADY_MERGED")

    def test_guests_merge_by_email_and_a_closed_source_stays_closed(self, client, admin_auth, support, db):
        first, _ = guest_ticket(client, email="same@example.com")
        second, _ = guest_ticket(client, email="SAME@example.com")
        set_status(client, admin_auth, second["id"], "closed")
        merged = client.post(f"{DESK}/{second['id']}/merge", headers=admin_auth, json={"other": first["number"]})
        assert merged.status_code == 200, merged.text
        assert merged.json()["message"] == f"Merged into {first['number']}."
        row = ticket_row(db, second["number"])
        assert row.status == "closed" and row.merged_into_id == first["id"]
        # Closed once, by hand -- the merge did not record a second close.
        assert sum(1 for e in row.events if e.kind == "status" and e.to_value == "closed") == 1
        other, _ = guest_ticket(client, email="different@example.com")
        error(client.post(f"{DESK}/{other['id']}/merge", headers=admin_auth, json={"other": first["number"]}), 409,
              "DIFFERENT_CUSTOMER")
        listed = [t["number"] for t in client.get(f"{DESK}?hideMerged=0", headers=admin_auth).json()["data"]]
        assert second["number"] in listed
        assert second["number"] not in [t["number"] for t in client.get(DESK, headers=admin_auth).json()["data"]]

    def test_linking_twice_keeps_one_link_and_unlinking_an_unknown_id_is_recorded(self, client, auth, admin_auth,
                                                                                  support, db):
        from app.models import TicketLink

        a = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        b = raise_ticket(client, auth, "Orders", "Missing Item").json()["data"]["ticket"]
        client.post(f"{DESK}/{a['id']}/links", headers=admin_auth, json={"other": b["number"]})
        again = client.post(f"{DESK}/{b['id']}/links", headers=admin_auth, json={"other": a["id"]})
        assert again.status_code == 200 and [link["number"] for link in again.json()["data"]["links"]] == [a["number"]]
        assert db.query(TicketLink).count() == 1
        error(client.post(f"{DESK}/{a['id']}/links", headers=admin_auth, json={"other": "nothing"}), 404,
              "TICKET_NOT_FOUND")
        unlinked = client.delete(f"{DESK}/{a['id']}/links/GHOST", headers=admin_auth).json()["data"]
        assert any(e["kind"] == "unlinked" and e["to"] == "GHOST" for e in unlinked["events"])
        assert len(unlinked["links"]) == 1


# ------------------------------------------------------------- access edges


class TestAccessEdges:
    def test_an_unknown_number_or_id_is_404(self, client, auth, admin_auth, support):
        error(client.get("/api/support/tickets/DCZ-1999-000001", headers=auth), 404, "TICKET_NOT_FOUND")
        error(client.get(f"{DESK}/NOPE", headers=admin_auth), 404, "TICKET_NOT_FOUND")

    def test_a_damaged_guest_key_opens_nothing(self, client, support, db):
        from app.services.support import tickets

        ticket, key = guest_ticket(client)
        row = ticket_row(db, ticket["number"])
        row.access_key = "not-a-sealed-value"
        db.flush()
        assert tickets.guest_key(row) == ""
        error(client.get(f"/api/support/tickets/{ticket['number']}", headers=key), 404, "TICKET_NOT_FOUND")

    def test_a_customer_ticket_has_no_guest_key(self, client, auth, support, db):
        from app.services.support import tickets

        data = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]
        assert data["key"] is None
        assert tickets.guest_key(ticket_row(db, data["ticket"]["number"])) == ""

    def test_attachment_links_belong_to_their_ticket(self, client, auth, admin_auth, support, stored):  # noqa: F811
        with_file = raise_ticket(client, auth, "Orders", "Order Status",
                                 files=[("files", ("photo.png", PNG, "image/png"))]).json()["data"]["ticket"]
        attachment = with_file["messages"][0]["attachments"][0]["id"]
        other = raise_ticket(client, auth, "Orders", "Missing Item").json()["data"]["ticket"]
        link = client.get(f"{DESK}/{with_file['id']}/attachments/{attachment}", headers=admin_auth)
        assert link.status_code == 200 and link.json()["data"]["name"] == "photo.png"
        assert link.json()["data"]["contentType"] == "image/png"
        error(client.get(f"{DESK}/{other['id']}/attachments/{attachment}", headers=admin_auth), 404,
              "ATTACHMENT_NOT_FOUND")
        error(client.get(f"{DESK}/{with_file['id']}/attachments/999999", headers=admin_auth), 404,
              "ATTACHMENT_NOT_FOUND")
        error(client.get(f"/api/support/tickets/{with_file['number']}/attachments/999999", headers=auth), 404,
              "ATTACHMENT_NOT_FOUND")

    def test_an_agent_without_a_team_sees_only_what_is_assigned_to_them(self, client, auth, admin_auth, support,
                                                                         editor):
        agent = add_agent(client, admin_auth, "Solo Agent", "Customer Support", adminUserId=editor.id)
        client.put(f"/api/admin/support/config/agents/{agent['id']}", headers=admin_auth,
                   json={"name": "Solo Agent", "email": agent["email"], "adminUserId": editor.id})
        mine = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        raise_ticket(client, auth, "Orders", "Missing Item")
        client.put(f"{DESK}/{mine['id']}/assignment", headers=admin_auth, json={"agentId": agent["id"]})
        headers = admin_login(client, editor)
        assert [t["number"] for t in client.get(DESK, headers=headers).json()["data"]] == [mine["number"]]
        assert client.get(f"{DESK}?agent=me", headers=headers).json()["data"][0]["number"] == mine["number"]
        dashboard = client.get("/api/admin/support/dashboard", headers=headers).json()["data"]
        assert dashboard["totals"]["total"] == 1
        me = client.get("/api/admin/support/me", headers=headers).json()["data"]
        assert me["canWork"] and not me["seesEverything"] and me["agent"]["name"] == "Solo Agent"

    def test_a_switched_off_agent_loses_the_desk(self, client, admin_auth, support, editor):
        agent = add_agent(client, admin_auth, "Former Agent", "Customer Support", adminUserId=editor.id)
        client.put(f"/api/admin/support/config/agents/{agent['id']}", headers=admin_auth, json={
            "name": "Former Agent", "email": agent["email"], "adminUserId": editor.id, "active": False})
        headers = admin_login(client, editor)
        error(client.get(DESK, headers=headers), 403, "PERMISSION_DENIED")
        assert client.get("/api/admin/support/me", headers=headers).json()["data"]["canWork"] is False


# ------------------------------------------------------------------- lists


class TestTheCustomersList:
    def test_tabs_and_search(self, client, auth, admin_auth, support, own_order):
        a = raise_ticket(client, auth, "Orders", "Order Status", orderId="ORD901").json()["data"]["ticket"]
        b = raise_ticket(client, auth, "Orders", "Missing Item").json()["data"]["ticket"]
        client.post(f"{DESK}/{b['id']}/messages", headers=admin_auth,
                    data={"body": "Which one?", "status": "waiting-customer"})

        def numbers(query=""):
            response = client.get(f"/api/support/tickets{query}", headers=auth)
            assert response.status_code == 200
            return {t["number"] for t in response.json()["data"]}

        assert numbers() == {a["number"], b["number"]}
        assert numbers("?status=open") == {a["number"]}
        assert numbers("?status=waiting") == {b["number"]}
        assert numbers("?status=resolved") == set()
        assert numbers("?status=nonsense") == {a["number"], b["number"]}
        assert numbers(f"?q={b['number']}") == {b["number"]}
        assert numbers("?q=DCZ19901") == {a["number"]}
        assert numbers("?q=missing") == {b["number"]}
        assert numbers("?q=nothing-like-it") == set()


@pytest.fixture()
def desk(client, auth, admin_auth, support, catalogue, own_order, db):
    """Five tickets with something different about each, for the filters."""
    from app.models import SupportTicket

    agent = add_agent(client, admin_auth, "Filter Agent", "Customer Support")
    tickets = {
        "order": raise_ticket(client, auth, "Orders", "Order Status", orderId="ORD901"),
        "payment": raise_ticket(client, auth, "Payments", "Payment Deducted but Order Failed", productId="PRD002"),
        "urgent": raise_ticket(client, auth, "Account", "Account Security"),
        "guest": raise_ticket(client, None, "General", "General Question", name="Gita Guest",
                              email="gita@example.com"),
        "feature": raise_ticket(client, auth, "Feedback", "Feature Request"),
    }
    out = {}
    for name, response in tickets.items():
        assert response.status_code == 201, response.text
        out[name] = response.json()["data"]["ticket"]
    out["agent"] = agent
    # Spread their ages so the sort order is unambiguous.
    for offset, name in enumerate(("order", "payment", "urgent", "guest", "feature")):
        row = db.query(SupportTicket).filter_by(number=out[name]["number"]).one()
        row.created_at = row.created_at - timedelta(hours=10 - offset)
    db.flush()
    return out


class TestTheDeskFilters:
    def _numbers(self, client, admin_auth, query):
        response = client.get(f"{DESK}?{query}", headers=admin_auth)
        assert response.status_code == 200, response.text
        return [t["number"] for t in response.json()["data"]]

    def test_filters(self, client, admin_auth, desk, db):
        n = {k: v["number"] for k, v in desk.items() if k != "agent"}
        find = lambda q: set(self._numbers(client, admin_auth, q))  # noqa: E731
        orders_ids = node(client, "Orders", "Order Status")
        assert find("") == set(n.values())
        assert find(f"category={orders_ids[0]}") == {n["order"]}
        assert find(f"subcategory={orders_ids[1]}") == {n["order"]}
        upi_issue = node(client, "Payments", "UPI Issue", "UPI app didn't open")[2]
        assert find(f"issue={upi_issue}") == set()
        assert find("category=abc") == set(n.values())
        assert find(f"team={team_id(client, admin_auth, 'Payments & Finance')}") == {n["payment"]}
        assert find("priority=urgent,high") == {n["urgent"], n["payment"]}
        assert find("contactType=feature") == {n["feature"]}
        assert find("featureStage=requested") == {n["feature"]}
        assert find("channel=chat") == set()
        assigned = {v["number"] for k, v in desk.items() if k != "agent" and v["agent"] == "Filter Agent"}
        assert assigned and n["order"] in assigned
        assert find("agent=unassigned") == set(n.values()) - assigned
        assert find(f"agent={desk['agent']['id']}") == assigned
        assert find("agent=me") == set()  # the super admin is not an agent
        assert find("customer=CUS001") == set(n.values()) - {n["guest"]}
        assert find("order=DCZ19901") == {n["order"]}
        assert find("order=ORD901") == {n["order"]}
        assert find("product=PRD002") == {n["payment"]}
        assert find("membership=1") == set()
        tomorrow = (datetime.utcnow() + timedelta(days=1)).strftime("%Y-%m-%d")
        yesterday = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
        assert find(f"from={tomorrow}") == set() and find(f"to={yesterday}") == set()
        assert find(f"from={yesterday}&to={tomorrow}") == set(n.values())
        assert find("from=not-a-date") == set(n.values())

    def test_text_search(self, client, admin_auth, desk):
        n = {k: v["number"] for k, v in desk.items() if k != "agent"}
        find = lambda q: set(self._numbers(client, admin_auth, q))  # noqa: E731
        assigned = {v["number"] for k, v in desk.items() if k != "agent" and v["agent"] == "Filter Agent"}
        assert find("q=Filter Agent") == assigned
        assert find("q=DCZ19901") == {n["order"]}
        assert find("q=gita@example") == {n["guest"]}
        assert find("q=Gita Guest") == {n["guest"]}
        assert find(f"q={n['urgent']}") == {n["urgent"]}
        assert find("q=PRD002") == {n["payment"]}

    def test_statuses_and_views(self, client, admin_auth, desk):
        n = {k: v["number"] for k, v in desk.items() if k != "agent"}
        find = lambda q: set(self._numbers(client, admin_auth, q))  # noqa: E731
        client.post(f"{DESK}/{desk['order']['id']}/messages", headers=admin_auth,
                    data={"body": "Which address?", "status": "waiting-customer"})
        set_status(client, admin_auth, desk["feature"]["id"], "resolved")
        assert find("view=waiting") == {n["order"]}
        assert find("view=done") == {n["feature"]}
        assert find("view=open") == set(n.values()) - {n["feature"]}
        assert find("status=resolved,bogus") == {n["feature"]}
        assert find("status=bogus") == set(n.values())  # an unknown status is ignored

    def test_sla_filters(self, client, admin_auth, desk, db):
        from app.models import SupportTicket

        n = {k: v["number"] for k, v in desk.items() if k != "agent"}
        find = lambda q: set(self._numbers(client, admin_auth, q))  # noqa: E731
        now = datetime.utcnow()
        rows = {k: db.query(SupportTicket).filter_by(number=v).one() for k, v in n.items()}
        rows["order"].resolve_due_at = now - timedelta(minutes=5)
        rows["payment"].sla_breached = True
        rows["urgent"].resolve_due_at = now + timedelta(hours=1)
        rows["guest"].resolve_due_at = now + timedelta(hours=30)
        rows["feature"].resolve_due_at = now + timedelta(hours=30)
        db.flush()
        assert find("sla=breached") == {n["order"], n["payment"]}
        assert find("sla=due-soon") == {n["urgent"]}
        assert find("sla=on-track") == {n["guest"], n["feature"]}
        assert find("sla=whatever") == set(n.values())

    def test_sorting_and_paging(self, client, admin_auth, desk):
        n = {k: v["number"] for k, v in desk.items() if k != "agent"}
        order = lambda q: self._numbers(client, admin_auth, q)  # noqa: E731
        assert order("sort=oldest") == [n[k] for k in ("order", "payment", "urgent", "guest", "feature")]
        assert order("sort=created") == [n[k] for k in ("feature", "guest", "urgent", "payment", "order")]
        assert order("sort=priority")[0] == n["urgent"] and order("sort=priority")[1] == n["payment"]
        assert order("sort=due")[0] == n["urgent"]
        page = client.get(f"{DESK}?sort=oldest&page=2&pageSize=2", headers=admin_auth).json()
        assert [t["number"] for t in page["data"]] == [n["urgent"], n["guest"]]
        assert page["pagination"]["total"] == 5

    def test_an_empty_scope_sees_nothing(self, desk, db):
        from app.services.support import queries

        assert queries.staff_tickets(db, {}, me=None, scope_team_ids=[]) == ([], 0)
        rows, total = queries.staff_tickets(db, {}, me=None)
        assert total == 5 and len(rows) == 5
