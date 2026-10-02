"""
Configuring the support desk: departments, roles, teams, agents, the
category tree, help articles, canned replies, email templates and the
settings document -- plus who is allowed to change any of it, and the
business-hours / chat-availability rules the contact page reads.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from tests.integration.test_email import outbox  # noqa: F401 -- fixture
from tests.integration.test_support import (  # noqa: F401 -- fixtures
    _fresh_limits,
    add_agent,
    admin_login,
    node,
    raise_ticket,
    store_admin,
    support,
    team_id,
)

pytestmark = pytest.mark.integration

BASE = "/api/admin/support/config"


@pytest.fixture(autouse=True)
def _no_mail(outbox):  # noqa: F811
    """Nothing in this module may reach a real mail server."""
    return outbox


def make_admin(db, user_id, email, role, permissions):
    from app.core.security import hash_password
    from app.models import AdminUser
    from tests.conftest import ADMIN_PASSWORD

    user = AdminUser(id=user_id, email=email, password_hash=hash_password(ADMIN_PASSWORD), name=f"{role} user",
                     role=role, permissions=permissions, status="active", created_at=datetime(2026, 1, 1))
    db.add(user)
    db.flush()
    return user


def config_data(client, admin_auth):
    response = client.get(BASE, headers=admin_auth)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def error(response, status, code):
    assert response.status_code == status, response.text
    body = response.json()
    assert body["success"] is False and body["error_code"] == code, body
    return body


# ------------------------------------------------------------- permissions


class TestWhoMayConfigure:
    def test_every_write_route_refuses_an_editor(self, client, support, editor):
        headers = admin_login(client, editor)
        for method, path, kwargs in (
            ("post", f"{BASE}/departments", {"json": {"name": "X"}}),
            ("put", f"{BASE}/roles/1", {"json": {"name": "X"}}),
            ("delete", f"{BASE}/teams/1", {}),
            ("post", f"{BASE}/articles", {"json": {"title": "X"}}),
            ("post", f"{BASE}/canned", {"json": {"title": "X"}}),
            ("put", f"{BASE}/templates/ticket_created", {"json": {"subject": "X", "body": "Hello"}}),
            ("post", f"{BASE}/templates/preview", {"json": {"subject": "X", "body": "Y"}}),
            ("put", f"{BASE}/settings", {"json": {"reopenDays": 3}}),
        ):
            response = getattr(client, method)(path, headers=headers, **kwargs)
            error(response, 403, "PERMISSION_DENIED")

    def test_the_support_config_permission_is_enough_without_super_admin(self, client, db, support):
        user = make_admin(db, "ADM010", "configurer@dailychoicezone.com", "staff", ["support-config"])
        headers = admin_login(client, user)
        response = client.post(f"{BASE}/departments", headers=headers, json={"name": "Night Shift"})
        assert response.status_code == 201, response.text
        me = client.get("/api/admin/support/me", headers=headers).json()["data"]
        assert me["canConfigure"] is True

    def test_an_admin_role_works_tickets_but_cannot_add_a_department(self, client, support, store_admin):  # noqa: F811
        headers = admin_login(client, store_admin)
        error(client.post(f"{BASE}/departments", headers=headers, json={"name": "Nope"}), 403, "PERMISSION_DENIED")

    def test_no_token_no_config(self, client, support):
        assert client.get(BASE).status_code == 401


# ------------------------------------------------------- departments/roles


class TestDepartments:
    def test_create_update_delete(self, client, admin_auth, support, db):
        from app.models import SupportDepartment

        created = client.post(f"{BASE}/departments", headers=admin_auth,
                              json={"name": "  Logistics  ", "description": "Couriers", "sortOrder": 9})
        assert created.status_code == 201, created.text
        data = created.json()["data"]
        assert data["name"] == "Logistics" and data["teams"] == 0 and data["active"] is True
        assert data["sortOrder"] == 9 and data["description"] == "Couriers"

        # Saving under its own name is not a clash with itself.
        updated = client.put(f"{BASE}/departments/{data['id']}", headers=admin_auth,
                             json={"name": "Logistics", "active": False})
        assert updated.status_code == 200 and updated.json()["data"]["active"] is False
        assert db.get(SupportDepartment, data["id"]).active is False

        removed = client.delete(f"{BASE}/departments/{data['id']}", headers=admin_auth)
        assert removed.status_code == 200 and removed.json()["message"] == "Deleted."
        db.expire_all()
        assert db.get(SupportDepartment, data["id"]) is None

    def test_names_are_required_and_unique_ignoring_case(self, client, admin_auth, support):
        error(client.post(f"{BASE}/departments", headers=admin_auth, json={"name": "   "}), 422, "FIELD_REQUIRED")
        error(client.post(f"{BASE}/departments", headers=admin_auth, json={"name": "customer SUPPORT"}),
              409, "DUPLICATE")

    def test_a_department_with_teams_is_not_deleted(self, client, admin_auth, support):
        dept = next(d for d in config_data(client, admin_auth)["departments"] if d["name"] == "Customer Support")
        assert dept["teams"] >= 1
        error(client.delete(f"{BASE}/departments/{dept['id']}", headers=admin_auth), 409, "IN_USE")

    def test_missing_ones_are_404(self, client, admin_auth, support):
        error(client.put(f"{BASE}/departments/999999", headers=admin_auth, json={"name": "X"}), 404, "NOT_FOUND")
        error(client.delete(f"{BASE}/departments/999999", headers=admin_auth), 404, "NOT_FOUND")


class TestRoles:
    def test_create_rename_and_delete_an_unused_role(self, client, admin_auth, support, db):
        from app.models import SupportRole

        created = client.post(f"{BASE}/roles", headers=admin_auth, json={"name": "Night Lead"})
        assert created.status_code == 201
        role = created.json()["data"]
        assert role["agents"] == 0
        renamed = client.put(f"{BASE}/roles/{role['id']}", headers=admin_auth,
                             json={"name": "Night Supervisor", "description": "After hours"})
        assert renamed.json()["data"]["name"] == "Night Supervisor"
        assert client.delete(f"{BASE}/roles/{role['id']}", headers=admin_auth).status_code == 200
        db.expire_all()
        assert db.get(SupportRole, role["id"]) is None

    def test_a_role_held_by_an_agent_stays(self, client, admin_auth, support):
        role = next(r for r in config_data(client, admin_auth)["roles"] if r["name"] == "Developer")
        add_agent(client, admin_auth, "Role Holder", "Developers", roleId=role["id"])
        listed = next(r for r in config_data(client, admin_auth)["roles"] if r["id"] == role["id"])
        assert listed["agents"] == 1
        error(client.delete(f"{BASE}/roles/{role['id']}", headers=admin_auth), 409, "IN_USE")

    def test_duplicates_and_missing(self, client, admin_auth, support):
        error(client.post(f"{BASE}/roles", headers=admin_auth, json={"name": "developer"}), 409, "DUPLICATE")
        error(client.post(f"{BASE}/roles", headers=admin_auth, json={}), 422, "FIELD_REQUIRED")
        error(client.put(f"{BASE}/roles/999999", headers=admin_auth, json={"name": "X"}), 404, "NOT_FOUND")
        error(client.delete(f"{BASE}/roles/999999", headers=admin_auth), 404, "NOT_FOUND")


# --------------------------------------------------------------------- teams


class TestTeams:
    def test_a_new_team_and_its_view(self, client, admin_auth, support):
        dept = next(d for d in config_data(client, admin_auth)["departments"] if d["name"] == "Engineering")
        created = client.post(f"{BASE}/teams", headers=admin_auth, json={
            "name": "Mobile", "departmentId": dept["id"], "notifyEmail": "Mobile@Staff.Example.com",
            "assignment": "least-active", "customerSelectable": True})
        assert created.status_code == 201, created.text
        team = created.json()["data"]
        assert team["department"] == "Engineering" and team["notifyEmail"] == "mobile@staff.example.com"
        assert team["assignment"] == "least-active" and team["customerSelectable"] is True
        assert (team["agents"], team["activeAgents"], team["availableAgents"], team["openTickets"]) == (0, 0, 0, 0)

        add_agent(client, admin_auth, "Mo Bile", "Mobile")
        add_agent(client, admin_auth, "Off Duty", "Mobile", available=False)
        add_agent(client, admin_auth, "Gone Away", "Mobile", active=False)
        listed = next(t for t in config_data(client, admin_auth)["teams"] if t["name"] == "Mobile")
        assert (listed["agents"], listed["activeAgents"], listed["availableAgents"]) == (3, 2, 1)

    def test_the_assignment_defaults_to_round_robin_and_no_department_is_fine(self, client, admin_auth, support):
        team = client.post(f"{BASE}/teams", headers=admin_auth, json={"name": "Floaters"}).json()["data"]
        assert team["assignment"] == "round-robin" and team["departmentId"] is None and team["department"] == ""

    @pytest.mark.parametrize("payload, code", [
        ({"name": "T", "departmentId": 999999}, "DEPARTMENT_NOT_FOUND"),
        ({"name": "T", "notifyEmail": "not-an-address"}, "INVALID_EMAIL"),
        ({"name": "T", "assignment": "whoever-is-closest"}, "INVALID_ASSIGNMENT"),
        ({"name": ""}, "FIELD_REQUIRED"),
    ])
    def test_validation(self, client, admin_auth, support, payload, code):
        error(client.post(f"{BASE}/teams", headers=admin_auth, json=payload), 422, code)

    def test_a_duplicate_name(self, client, admin_auth, support):
        error(client.post(f"{BASE}/teams", headers=admin_auth, json={"name": "developers"}), 409, "DUPLICATE")

    def test_deleting_follows_what_uses_the_team(self, client, admin_auth, support, db):
        from app.models import SupportTeam

        free = client.post(f"{BASE}/teams", headers=admin_auth, json={"name": "Temp"}).json()["data"]
        assert client.delete(f"{BASE}/teams/{free['id']}", headers=admin_auth).status_code == 200
        db.expire_all()
        assert db.get(SupportTeam, free["id"]) is None

        staffed = client.post(f"{BASE}/teams", headers=admin_auth, json={"name": "Staffed"}).json()["data"]
        add_agent(client, admin_auth, "Staff One", "Staffed")
        error(client.delete(f"{BASE}/teams/{staffed['id']}", headers=admin_auth), 409, "IN_USE")

        routed = client.post(f"{BASE}/teams", headers=admin_auth, json={"name": "Routed"}).json()["data"]
        orders = node(client, "Orders")[0]
        made = client.post(f"{BASE}/categories", headers=admin_auth,
                           json={"name": "Bulk Orders", "parentId": orders, "teamId": routed["id"]})
        assert made.status_code == 201, made.text
        error(client.delete(f"{BASE}/teams/{routed['id']}", headers=admin_auth), 409, "IN_USE")

    def test_missing(self, client, admin_auth, support):
        error(client.put(f"{BASE}/teams/999999", headers=admin_auth, json={"name": "X"}), 404, "NOT_FOUND")
        error(client.delete(f"{BASE}/teams/999999", headers=admin_auth), 404, "NOT_FOUND")


# -------------------------------------------------------------------- agents


class TestAgents:
    def test_the_full_record_and_its_view(self, client, admin_auth, admin, support):
        role = next(r for r in config_data(client, admin_auth)["roles"] if r["name"] == "Developer")
        agent = add_agent(client, admin_auth, "Full Record", "Developers", roleId=role["id"],
                          phone="+91 98765 43210", photoUrl="https://cdn.example.com/a.png",
                          specialization="Payments API", isLead=True, showToCustomers=True,
                          notifyEmail=False, adminUserId=admin.id)
        assert agent["phone"] == "9876543210" and agent["role"] == "Developer" and agent["team"] == "Developers"
        assert agent["isLead"] and agent["showToCustomers"] and agent["notifyEmail"] is False
        assert agent["notifyPortal"] is True and agent["active"] and agent["available"]
        assert agent["adminUser"] == {"id": admin.id, "name": admin.name, "email": admin.email, "role": admin.role}
        assert agent["openTickets"] == 0

        me = client.get("/api/admin/support/me", headers=admin_auth).json()["data"]
        assert me["agent"]["id"] == agent["id"]

        updated = client.put(f"{BASE}/agents/{agent['id']}", headers=admin_auth,
                             json={"name": "Full Record", "email": agent["email"], "phone": ""})
        assert updated.status_code == 200, updated.text
        data = updated.json()["data"]
        # Unsent flags fall back to their defaults; unsent links are cleared.
        assert data["phone"] == "" and data["roleId"] is None and data["teamId"] is None
        assert data["adminUser"] is None and data["isLead"] is False and data["notifyEmail"] is True

    @pytest.mark.parametrize("extra, code", [
        ({"email": "nobody"}, "INVALID_EMAIL"),
        ({"phone": "12345"}, "INVALID_PHONE"),
        ({"photoUrl": "javascript:alert(1)"}, "INVALID_PHOTO"),
        ({"roleId": 999999}, "NOT_FOUND"),
        ({"teamId": 999999}, "NOT_FOUND"),
        ({"adminUserId": "ADM999"}, "ADMIN_NOT_FOUND"),
        ({"name": ""}, "FIELD_REQUIRED"),
        ({"email": ""}, "FIELD_REQUIRED"),
    ])
    def test_validation(self, client, admin_auth, support, extra, code):
        payload = {"name": "Val Idator", "email": "val@staff.example.com", **extra}
        error(client.post(f"{BASE}/agents", headers=admin_auth, json=payload), 422, code)

    def test_an_email_or_portal_account_belongs_to_one_agent(self, client, admin_auth, admin, support):
        first = add_agent(client, admin_auth, "First One", "Developers", adminUserId=admin.id)
        error(client.post(f"{BASE}/agents", headers=admin_auth,
                          json={"name": "Copy", "email": first["email"].upper()}), 409, "DUPLICATE")
        body = error(client.post(f"{BASE}/agents", headers=admin_auth,
                                 json={"name": "Second", "email": "second@staff.example.com",
                                       "adminUserId": admin.id}), 409, "DUPLICATE")
        assert "First One" in body["message"]
        # Re-saving the first with its own account is fine.
        again = client.put(f"{BASE}/agents/{first['id']}", headers=admin_auth,
                           json={"name": "First One", "email": first["email"], "adminUserId": admin.id})
        assert again.status_code == 200, again.text

    def test_an_agent_with_history_stays(self, client, auth, admin_auth, support, db):
        from app.models import SupportAgent

        busy = add_agent(client, admin_auth, "Busy Bee", "Customer Support")
        idle = add_agent(client, admin_auth, "Idle Ian", "Product Team")
        ticket = raise_ticket(client, auth, "Orders", "Order Status").json()["data"]["ticket"]
        assert ticket["agent"] == "Busy Bee"
        error(client.delete(f"{BASE}/agents/{busy['id']}", headers=admin_auth), 409, "IN_USE")
        assert client.delete(f"{BASE}/agents/{idle['id']}", headers=admin_auth).status_code == 200
        db.expire_all()
        assert db.get(SupportAgent, idle["id"]) is None and db.get(SupportAgent, busy["id"]) is not None
        listed = next(a for a in config_data(client, admin_auth)["agents"] if a["id"] == busy["id"])
        assert listed["openTickets"] == 1

    def test_missing(self, client, admin_auth, support):
        error(client.put(f"{BASE}/agents/999999", headers=admin_auth,
                         json={"name": "X", "email": "x@staff.example.com"}), 404, "NOT_FOUND")
        error(client.delete(f"{BASE}/agents/999999", headers=admin_auth), 404, "NOT_FOUND")

    def test_portal_accounts_list_only_active_admins(self, client, admin_auth, admin, editor, db, support):
        editor.status = "disabled"
        db.flush()
        accounts = config_data(client, admin_auth)["portalAccounts"]
        assert [a["id"] for a in accounts] == [admin.id]


# ---------------------------------------------------------------- categories


class TestCategories:
    def test_a_three_level_branch(self, client, admin_auth, support):
        team = team_id(client, admin_auth, "Developers")
        top = client.post(f"{BASE}/categories", headers=admin_auth, json={
            "name": "Mobile App", "contactType": "bug", "form": "bug", "priority": "high", "teamId": team,
            "customerChoice": "team", "choiceTeamIds": [team], "slaHours": -5, "icon": "phone"})
        assert top.status_code == 201, top.text
        top_id = top.json()["data"]["id"]
        option = client.post(f"{BASE}/categories", headers=admin_auth,
                             json={"name": "Crashes", "parentId": top_id}).json()["data"]
        issue = client.post(f"{BASE}/categories", headers=admin_auth,
                            json={"name": "On launch", "parentId": option["id"]})
        assert issue.status_code == 201, issue.text
        too_deep = client.post(f"{BASE}/categories", headers=admin_auth,
                               json={"name": "Deeper", "parentId": issue.json()["data"]["id"]})
        error(too_deep, 422, "TOO_DEEP")

        tree = config_data(client, admin_auth)["categories"]
        mobile = next(n for n in tree if n["id"] == top_id)
        assert mobile["slug"] == "mobile-app" and mobile["slaHours"] == 0 and mobile["choiceTeamIds"] == [team]
        crashes = mobile["children"][0]
        assert crashes["level"] == 2 and crashes["resolved"]["form"] == "bug"
        assert crashes["resolved"]["customerChoice"] == "team"
        assert crashes["children"][0]["level"] == 3

    @pytest.mark.parametrize("payload, code", [
        ({"name": "Top", "form": "general"}, "FIELD_REQUIRED"),
        ({"name": "Top", "contactType": "spam", "form": "general"}, "INVALID_TYPE"),
        ({"name": "Top", "contactType": "general", "form": "survey"}, "INVALID_FORM"),
        ({"name": "Top", "contactType": "general", "form": "general", "priority": "asap"}, "INVALID_PRIORITY"),
        ({"name": "Top", "contactType": "general", "form": "general", "customerChoice": "anyone"},
         "INVALID_CHOICE"),
        ({"name": "Top", "contactType": "general", "form": "general", "teamId": 999999}, "TEAM_NOT_FOUND"),
        ({"name": "Top", "contactType": "general", "form": "general", "choiceTeamIds": [999999]},
         "TEAM_NOT_FOUND"),
        ({"name": ""}, "FIELD_REQUIRED"),
    ])
    def test_validation(self, client, admin_auth, support, payload, code):
        error(client.post(f"{BASE}/categories", headers=admin_auth, json=payload), 422, code)

    def test_names_are_unique_among_siblings_only(self, client, admin_auth, support):
        orders, status = node(client, "Orders", "Order Status")
        error(client.post(f"{BASE}/categories", headers=admin_auth,
                          json={"name": "ORDERS", "contactType": "general", "form": "general"}), 409, "DUPLICATE")
        error(client.post(f"{BASE}/categories", headers=admin_auth,
                          json={"name": "Order status", "parentId": orders}), 409, "DUPLICATE")
        # The same name under another parent is fine.
        payments = node(client, "Payments")[0]
        fine = client.post(f"{BASE}/categories", headers=admin_auth, json={"name": "Order Status", "parentId": payments})
        assert fine.status_code == 201
        # Renaming a node onto a sibling's name clashes; keeping its own name does not.
        error(client.put(f"{BASE}/categories/{status}", headers=admin_auth, json={"name": "Missing Item"}),
              409, "DUPLICATE")
        assert client.put(f"{BASE}/categories/{status}", headers=admin_auth,
                          json={"name": "Order Status"}).status_code == 200

    def test_a_missing_parent_or_node(self, client, admin_auth, support):
        error(client.post(f"{BASE}/categories", headers=admin_auth, json={"name": "Orphan", "parentId": 999999}),
              404, "NOT_FOUND")
        error(client.put(f"{BASE}/categories/999999", headers=admin_auth, json={"name": "X"}), 404, "NOT_FOUND")
        error(client.delete(f"{BASE}/categories/999999", headers=admin_auth), 404, "NOT_FOUND")

    def test_deleting(self, client, auth, admin_auth, support, db):
        from app.models import SupportCategory

        orders, status = node(client, "Orders", "Order Status")
        error(client.delete(f"{BASE}/categories/{orders}", headers=admin_auth), 409, "IN_USE")
        raise_ticket(client, auth, "Orders", "Order Status")
        error(client.delete(f"{BASE}/categories/{status}", headers=admin_auth), 409, "IN_USE")
        spare = client.post(f"{BASE}/categories", headers=admin_auth,
                            json={"name": "Spare", "parentId": orders}).json()["data"]
        assert client.delete(f"{BASE}/categories/{spare['id']}", headers=admin_auth).status_code == 200
        db.expire_all()
        assert db.get(SupportCategory, spare["id"]) is None


# ------------------------------------------------------------------ articles


ARTICLE = {"title": "Track a parcel", "body": "Open Account, Orders, then choose Track to follow it.",
           "summary": "Follow your parcel.", "keywords": "track parcel courier"}


class TestArticles:
    def test_create_update_delete(self, client, admin_auth, support, db):
        from app.models import SupportArticle

        orders = node(client, "Orders")[0]
        created = client.post(f"{BASE}/articles", headers=admin_auth,
                              json={**ARTICLE, "categoryIds": [orders, 999999]})
        assert created.status_code == 201, created.text
        article = created.json()["data"]
        assert article["slug"] == "track-a-parcel" and article["categoryIds"] == [orders]
        assert article["body"].startswith("Open Account") and article["views"] == 0

        updated = client.put(f"{BASE}/articles/{article['id']}", headers=admin_auth,
                             json={**ARTICLE, "slug": "Where Is It", "active": False})
        assert updated.json()["data"]["slug"] == "where-is-it" and updated.json()["data"]["active"] is False

        assert client.delete(f"{BASE}/articles/{article['id']}", headers=admin_auth).status_code == 200
        db.expire_all()
        assert db.get(SupportArticle, article["id"]) is None
        error(client.delete(f"{BASE}/articles/{article['id']}", headers=admin_auth), 404, "NOT_FOUND")

    def test_validation(self, client, admin_auth, support):
        error(client.post(f"{BASE}/articles", headers=admin_auth, json={**ARTICLE, "title": ""}), 422,
              "FIELD_REQUIRED")
        error(client.post(f"{BASE}/articles", headers=admin_auth, json={**ARTICLE, "body": "Too short"}), 422,
              "FIELD_REQUIRED")
        error(client.post(f"{BASE}/articles", headers=admin_auth, json={**ARTICLE, "slug": "cancel-an-order"}),
              409, "DUPLICATE")
        error(client.put(f"{BASE}/articles/999999", headers=admin_auth, json=ARTICLE), 404, "NOT_FOUND")


class TestTheHelpCentre:
    def test_without_a_query_the_first_active_articles_in_order(self, client, support):
        response = client.get("/api/support/articles")
        assert response.status_code == 200
        rows = response.json()["data"]
        assert len(rows) == 6 and rows[0]["slug"] == "cancel-an-order"
        assert "body" not in rows[0]

    def test_words_rank_title_and_keyword_matches_first(self, client, support):
        rows = client.get("/api/support/articles?q=cancel").json()["data"]
        assert rows[0]["slug"] == "cancel-an-order"
        assert client.get("/api/support/articles?q=zzzqqq").json()["data"] == []
        # Words of two letters or fewer are ignored, which leaves nothing to rank by.
        assert len(client.get("/api/support/articles?q=to").json()["data"]) == 6

    def test_a_category_filter_finds_its_articles(self, client, support):
        cancellation = node(client, "Orders", "Order Cancellation")[1]
        rows = client.get(f"/api/support/articles?categories={cancellation},abc,").json()["data"]
        assert [r["slug"] for r in rows] == ["cancel-an-order"]

    def test_inactive_articles_are_hidden(self, client, admin_auth, support):
        created = client.post(f"{BASE}/articles", headers=admin_auth,
                              json={**ARTICLE, "active": False}).json()["data"]
        assert all(r["id"] != created["id"] for r in client.get("/api/support/articles?q=parcel").json()["data"])
        error(client.get(f"/api/support/articles/{created['slug']}"), 404, "ARTICLE_NOT_FOUND")

    def test_reading_counts_a_view(self, client, support, db):
        from app.models import SupportArticle

        first = client.get("/api/support/articles/cancel-an-order")
        assert first.status_code == 200 and first.json()["data"]["views"] == 1
        assert "body" in first.json()["data"]
        assert client.get("/api/support/articles/cancel-an-order").json()["data"]["views"] == 2
        row = db.query(SupportArticle).filter_by(slug="cancel-an-order").one()
        assert row.views == 2
        error(client.get("/api/support/articles/no-such-article"), 404, "ARTICLE_NOT_FOUND")

    def test_feedback_counts_both_ways(self, client, support, db):
        from app.models import SupportArticle

        row = db.query(SupportArticle).filter_by(slug="cancel-an-order").one()
        path = f"/api/support/articles/{row.id}/feedback"
        assert client.post(path, json={"helpful": True}).status_code == 200
        assert client.post(path, json={"helpful": True}).status_code == 200
        assert client.post(path, json={"helpful": False}).json()["message"] == "Thanks for letting us know."
        db.refresh(row)
        assert (row.helpful, row.not_helpful) == (2, 1)
        error(client.post("/api/support/articles/999999/feedback", json={"helpful": True}), 404,
              "ARTICLE_NOT_FOUND")
        assert client.post(path, json={}).status_code == 422

    def test_feedback_is_rate_limited(self, client, support, db):
        from app.models import SupportArticle

        row = db.query(SupportArticle).filter_by(slug="cancel-an-order").one()
        codes = [client.post(f"/api/support/articles/{row.id}/feedback", json={"helpful": True}).status_code
                 for _ in range(31)]
        assert codes[:30] == [200] * 30 and codes[30] == 429


# ------------------------------------------------------------ canned replies


class TestCannedReplies:
    def test_create_update_delete_and_the_desk_sees_only_active_ones(self, client, admin_auth, support, db):
        from app.models import CannedResponse

        orders = node(client, "Orders")[0]
        created = client.post(f"{BASE}/canned", headers=admin_auth,
                              json={"title": "Shipping soon", "body": "It ships tomorrow.", "categoryId": orders})
        assert created.status_code == 201, created.text
        reply = created.json()["data"]
        assert reply["categoryId"] == orders and reply["active"] is True
        hidden = client.post(f"{BASE}/canned", headers=admin_auth, json={
            "title": "Old", "body": "Retired text", "categoryId": 999999, "active": False}).json()["data"]
        assert hidden["categoryId"] is None

        lookups = client.get("/api/admin/support/lookups", headers=admin_auth).json()["data"]
        assert [c["title"] for c in lookups["canned"]] == ["Shipping soon"]

        updated = client.put(f"{BASE}/canned/{reply['id']}", headers=admin_auth,
                             json={"title": "Shipping today", "body": "It ships today."})
        assert updated.json()["data"]["title"] == "Shipping today" and updated.json()["data"]["categoryId"] is None

        assert client.delete(f"{BASE}/canned/{reply['id']}", headers=admin_auth).status_code == 200
        db.expire_all()
        assert db.get(CannedResponse, reply["id"]) is None
        error(client.delete(f"{BASE}/canned/{reply['id']}", headers=admin_auth), 404, "NOT_FOUND")

    def test_validation(self, client, admin_auth, support):
        error(client.post(f"{BASE}/canned", headers=admin_auth, json={"title": "", "body": "x"}), 422,
              "FIELD_REQUIRED")
        error(client.post(f"{BASE}/canned", headers=admin_auth, json={"title": "Empty", "body": "  "}), 422,
              "FIELD_REQUIRED")
        error(client.put(f"{BASE}/canned/999999", headers=admin_auth, json={"title": "X", "body": "Y"}), 404,
              "NOT_FOUND")


# ----------------------------------------------------------------- templates


class TestTemplates:
    def test_saving_and_switching_one_off(self, client, admin_auth, support, db):
        from app.services.support import notify

        saved = client.put(f"{BASE}/templates/ticket_created", headers=admin_auth, json={
            "subject": "Got it: {{ ticket_number }}", "body": "Hi {{customer_name}}, thanks.", "enabled": False})
        assert saved.status_code == 200, saved.text
        data = saved.json()["data"]
        assert data["key"] == "ticket_created" and data["enabled"] is False
        assert data["subject"] == "Got it: {{ ticket_number }}"
        assert notify._template(db, "ticket_created") is None

    def test_validation(self, client, admin_auth, support):
        error(client.put(f"{BASE}/templates/ticket_created", headers=admin_auth,
                         json={"subject": "", "body": "Hello there"}), 422, "FIELD_REQUIRED")
        error(client.put(f"{BASE}/templates/ticket_created", headers=admin_auth,
                         json={"subject": "Hi", "body": "Hey"}), 422, "FIELD_REQUIRED")
        body = error(client.put(f"{BASE}/templates/ticket_created", headers=admin_auth,
                                json={"subject": "{{zeta}} {{alpha}}", "body": "Hello there"}), 422,
                     "UNKNOWN_VARIABLE")
        assert body["message"].index("alpha") < body["message"].index("zeta")
        error(client.put(f"{BASE}/templates/no_such_template", headers=admin_auth,
                         json={"subject": "Hi", "body": "Hello there"}), 404, "NOT_FOUND")

    def test_preview_renders_sample_values_and_escapes_html(self, client, admin_auth, support):
        response = client.post(f"{BASE}/templates/preview", headers=admin_auth, json={
            "subject": "Hi {{customer_name}} about {{ticket_number}}",
            "body": "Line one {{priority}}\nline two\n\n<script>{{message}}</script>\n\n{{reopen_days}}"})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["subject"] == "Hi Asha Rao about DCZ-2026-000123"
        html = data["html"]
        assert "Line one High<br>line two" in html
        assert "[reopen_days]" in html
        assert "Could you share the transaction reference" in html
        assert client.post(f"{BASE}/templates/preview", headers=admin_auth, json={"subject": "x"}).status_code == 422


# ----------------------------------------------------------------- settings


def put_settings(client, admin_auth, payload):
    return client.put(f"{BASE}/settings", headers=admin_auth, json=payload)


SLA = {"low": {"response": 24, "resolve": 48}, "medium": {"response": 8, "resolve": 24},
       "high": {"response": 4, "resolve": 8}, "urgent": {"response": 1, "resolve": 2}}


class TestSettings:
    @pytest.mark.parametrize("payload, code", [
        ({"ticketPrefix": "TKT"}, "NUMBERING_LOCKED"),
        ({"defaultPriority": "asap"}, "INVALID_PRIORITY"),
        ({"defaultTeamId": 999999}, "TEAM_NOT_FOUND"),
        ({"sla": {**SLA, "high": {"response": "soon", "resolve": 8}}}, "INVALID_SLA"),
        ({"sla": {**SLA, "low": {"response": 0, "resolve": 8}}}, "INVALID_SLA"),
        ({"sla": {**SLA, "low": {"response": 1, "resolve": 24 * 91}}}, "INVALID_SLA"),
        ({"sla": {**SLA, "urgent": {}}}, "INVALID_SLA"),
        ({"slaWarningPercent": 5}, "INVALID_SLA"),
        ({"slaWarningPercent": 99}, "INVALID_SLA"),
        ({"escalation": [{"when": "never", "notify": "admins"}]}, "INVALID_ESCALATION"),
        ({"escalation": [{"when": "unresolved", "notify": "the-ceo"}]}, "INVALID_ESCALATION"),
        ({"businessHours": {"timezone": "Mars/Olympus_Mons"}}, "INVALID_TIMEZONE"),
        ({"businessHours": {"days": {"mon": {"open": "19:00", "close": "09:00"}}}}, "INVALID_HOURS"),
        ({"businessHours": {"days": {"tue": {"open": "9am", "close": "17:00"}}}}, "INVALID_HOURS"),
        ({"holidays": [{"date": "31/12/2026", "name": "NYE"}]}, "INVALID_HOLIDAY"),
        ({"reopenDays": 91}, "INVALID_SETTING"),
        ({"autoCloseResolvedDays": -1}, "INVALID_SETTING"),
        ({"duplicateWindowDays": 366}, "INVALID_SETTING"),
    ])
    def test_refusals(self, client, admin_auth, support, payload, code):
        error(put_settings(client, admin_auth, payload), 422, code)

    def test_the_fixed_prefix_may_be_sent_back_unchanged(self, client, admin_auth, support):
        response = put_settings(client, admin_auth, {"ticketPrefix": "DCZ", "defaultPriority": "low"})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["defaultPriority"] == "low"

    def test_everything_valid_is_stored_and_normalised(self, client, admin_auth, support, db):
        from app.models import SettingDocument

        team = team_id(client, admin_auth, "Developers")
        response = put_settings(client, admin_auth, {
            "defaultTeamId": str(team),
            "sla": {**SLA, "low": {"response": "12", "resolve": 36.5}},
            "slaWarningPercent": "70",
            "escalation": [
                {"when": "unresolved", "notify": "admins", "afterMinutes": -10, "priorities": ["high", "bogus"],
                 "label": "L" * 200},
                {"id": "custom", "when": "no-response", "notify": "team-lead"},
            ],
            "businessHours": {"timezone": "Europe/London",
                              "days": {"mon": {"open": "08:00", "close": "16:00"}, "sat": None}},
            "holidays": [{"date": "2026-12-25", "name": "Christmas"}, {"date": "2026-01-26"}],
            "chat": {"enabled": 1},
            "reopenDays": 0, "autoCloseResolvedDays": 90, "duplicateWindowDays": 365,
            "attachments": {"maxFiles": 50, "maxSizeMb": 0, "maxVideoSizeMb": 500},
            "unknownKey": "dropped",
        })
        assert response.status_code == 200, response.text
        assert response.json()["message"] == "Support settings saved."
        stored = db.get(SettingDocument, "support").value
        assert stored["defaultTeamId"] == team
        assert stored["sla"]["low"] == {"response": 12.0, "resolve": 36.5}
        assert stored["slaWarningPercent"] == 70
        first, second = stored["escalation"]
        assert first["id"] == "rule-1" and first["afterMinutes"] == 0 and first["priorities"] == ["high"]
        assert len(first["label"]) == 120 and second["id"] == "custom" and second["priorities"] == []
        hours = stored["businessHours"]
        assert hours["timezone"] == "Europe/London" and hours["days"]["mon"] == {"open": "08:00", "close": "16:00"}
        assert hours["days"]["tue"] is None and hours["days"]["sat"] is None
        assert [h["date"] for h in stored["holidays"]] == ["2026-01-26", "2026-12-25"]
        assert stored["holidays"][0]["name"] == ""
        assert stored["chat"] == {"enabled": True, "onlyInBusinessHours": True}
        assert (stored["reopenDays"], stored["autoCloseResolvedDays"], stored["duplicateWindowDays"]) == (0, 90, 365)
        # 0 is "not given", so the default applies before the clamp.
        assert stored["attachments"] == {"maxFiles": 10, "maxSizeMb": 10, "maxVideoSizeMb": 100}
        assert "unknownKey" not in stored

    def test_the_default_team_can_be_cleared_and_the_timezone_defaults(self, client, admin_auth, support):
        data = put_settings(client, admin_auth, {"defaultTeamId": None, "businessHours": {}, "escalation": None,
                                                 "holidays": None, "chat": None}).json()["data"]
        assert data["defaultTeamId"] is None and data["escalation"] == [] and data["holidays"] == []
        assert data["businessHours"]["timezone"] == "Asia/Kolkata"
        assert all(v is None for v in data["businessHours"]["days"].values())
        assert data["chat"] == {"enabled": False, "onlyInBusinessHours": True}

    def test_a_store_without_a_settings_document_gets_one(self, db):
        from app.models import SettingDocument
        from app.services.support import config

        assert db.get(SettingDocument, "support") is None
        defaults = config.settings(db)
        assert defaults["defaultTeamId"] is None and "defaultTeam" not in defaults
        out = config.save_settings(db, {"reopenDays": 3})
        assert out["reopenDays"] == 3
        assert db.get(SettingDocument, "support").value["reopenDays"] == 3

    # Regression: was a real bug, fixed alongside this test.
    def test_a_non_number_is_a_validation_error_not_a_crash(self, client, admin_auth, support):
        assert put_settings(client, admin_auth, {"reopenDays": "soon"}).status_code == 422


# ------------------------------------------------------- hours and the chat


def at_ist(year, month, day, hour, minute=0):
    """A UTC naive datetime for the given India time."""
    from datetime import timedelta

    return datetime(year, month, day, hour, minute) - timedelta(hours=5, minutes=30)


class TestBusinessHours:
    def test_zone_falls_back_to_ist(self):
        from app.services.support import config

        assert config.zone("Not/AZone") is config._IST
        assert config.zone("").key == "Asia/Kolkata"
        assert config.zone(None).key == "Asia/Kolkata"

    def test_open_inside_hours_closed_outside_on_sundays_and_holidays(self, client, admin_auth, support, db):
        from app.services.support import config

        # 2026-10-05 is a Monday; 2026-10-10 a Saturday; 2026-10-11 a Sunday.
        assert config.is_open(db, at_ist(2026, 10, 5, 9, 0)) is True
        assert config.is_open(db, at_ist(2026, 10, 5, 18, 59)) is True
        assert config.is_open(db, at_ist(2026, 10, 5, 19, 0)) is False
        assert config.is_open(db, at_ist(2026, 10, 5, 8, 59)) is False
        assert config.is_open(db, at_ist(2026, 10, 10, 16, 0)) is True
        assert config.is_open(db, at_ist(2026, 10, 10, 17, 30)) is False
        assert config.is_open(db, at_ist(2026, 10, 11, 12, 0)) is False

        put_settings(client, admin_auth, {"holidays": [{"date": "2026-10-05", "name": "Festival"}]})
        assert config.is_open(db, at_ist(2026, 10, 5, 12, 0)) is False
        assert config.is_open(db, at_ist(2026, 10, 6, 12, 0)) is True

    def test_the_summary_groups_runs_of_days(self, client, admin_auth, support, db):
        from app.services.support import config

        assert config.hours_summary(db) == (
            "Mon–Fri 09:00–19:00 · Sat 10:00–17:00 · Sun closed")
        put_settings(client, admin_auth, {"businessHours": {"days": {
            "mon": {"open": "09:00", "close": "17:00"}, "wed": {"open": "09:00", "close": "17:00"}}}})
        assert config.hours_summary(db) == (
            "Mon 09:00–17:00 · Tue closed · Wed 09:00–17:00 · Thu–Sun closed")
        assert client.get("/api/support/config").json()["data"]["hours"] == config.hours_summary(db)


class TestChatAvailability:
    def test_switched_off(self, client, admin_auth, support, db):
        from app.services.support import config

        put_settings(client, admin_auth, {"chat": {"enabled": False}})
        status = config.chat_status(db)
        assert status["available"] is False and status["reason"] == "disabled" and status["hours"]

    def test_closed_outside_business_hours(self, client, admin_auth, support, db, monkeypatch):
        from app.services.support import config

        put_settings(client, admin_auth, {"chat": {"enabled": True, "onlyInBusinessHours": True}})
        monkeypatch.setattr(config, "is_open", lambda db, now=None: False)
        assert config.chat_status(db)["reason"] == "closed"
        monkeypatch.setattr(config, "is_open", lambda db, now=None: True)
        assert config.chat_status(db)["reason"] == "nobody"

    def test_an_agent_must_be_linked_active_and_available(self, client, admin_auth, admin, support, db):
        from app.services.support import config

        put_settings(client, admin_auth, {"chat": {"enabled": True, "onlyInBusinessHours": False}})
        add_agent(client, admin_auth, "Unlinked", "Customer Support")
        assert config.chat_status(db)["reason"] == "nobody"
        linked = add_agent(client, admin_auth, "Linked", "Customer Support", adminUserId=admin.id, available=False)
        assert config.chat_status(db)["reason"] == "nobody"
        client.put(f"{BASE}/agents/{linked['id']}", headers=admin_auth,
                   json={"name": "Linked", "email": linked["email"], "adminUserId": admin.id, "available": True})
        assert config.chat_status(db) == {"available": True, "reason": "", "hours": config.hours_summary(db)}
        error(client.post("/api/support/chat", data={"data": "[]"}), 422, "INVALID_PAYLOAD")


# ------------------------------------------------------------ routing rules


class TestRouting:
    def test_nothing_resolves_to_the_store_defaults(self, client, admin_auth, support, db):
        from app.services.support import config

        routing = config.resolve(db, None)
        assert (routing.contact_type, routing.form, routing.priority) == ("support", "general", "medium")
        assert routing.team_id == team_id(client, admin_auth, "Customer Support")
        assert routing.customer_choice == "" and routing.choice_team_ids == [] and routing.sla_hours == 0

    def test_a_loop_in_the_tree_does_not_hang(self, support, db):
        from app.models import SupportCategory
        from app.services.support import config

        row = db.query(SupportCategory).filter_by(name="Orders", level=1).one()
        child = db.query(SupportCategory).filter_by(parent_id=row.id).first()
        row.parent_id = child.id  # a corrupted tree
        db.flush()
        assert [n.id for n in config.chain(db, child)] == [child.id, row.id]

    def test_due_dates_respect_an_override_and_an_unknown_priority(self, support, db):
        from datetime import timedelta

        from app.services.support import config

        start = datetime(2026, 10, 1, 12, 0)
        assert config.due_dates(db, "urgent", start) == (start + timedelta(hours=1), start + timedelta(hours=2))
        # A category's own SLA overrides resolution, and the first reply never falls after it.
        assert config.due_dates(db, "low", start, override_hours=6) == (start + timedelta(hours=6),
                                                                       start + timedelta(hours=6))
        assert config.sla_hours(db, "whenever") == {"response": 8, "resolve": 24}

    def test_handlers_for_a_missing_or_switched_off_option(self, client, support, db):
        from app.models import SupportCategory

        error(client.get("/api/support/categories/999999/handlers"), 404, "CATEGORY_NOT_FOUND")
        row = db.query(SupportCategory).filter_by(name="Orders", level=1).one()
        row.active = False
        db.flush()
        error(client.get(f"/api/support/categories/{row.id}/handlers"), 404, "CATEGORY_NOT_FOUND")
        # And its children vanish from the public tree with it.
        names = [n["name"] for n in client.get("/api/support/config").json()["data"]["categories"]]
        assert "Orders" not in names


class TestLookups:
    def test_the_desk_menus(self, client, admin_auth, support):
        add_agent(client, admin_auth, "Look Up", "Developers", available=False)
        response = client.get("/api/admin/support/lookups", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert {"Customer Support", "Developers"} <= {t["name"] for t in data["teams"]}
        assert data["agents"] == [{"id": data["agents"][0]["id"], "name": "Look Up",
                                   "teamId": team_id(client, admin_auth, "Developers"),
                                   "active": True, "available": False}]
        assert [s["value"] for s in data["statuses"]][0] == "submitted"
        assert [p["value"] for p in data["priorities"]] == ["low", "medium", "high", "urgent"]
        assert data["featureStages"][-1] == {"value": "rejected", "label": "Not planned"}
        assert "feature" in data["contactTypes"] and data["categories"]

    def test_only_people_who_work_tickets(self, client, db, support, editor):
        error(client.get("/api/admin/support/lookups", headers=admin_login(client, editor)), 403,
              "PERMISSION_DENIED")
        staff = make_admin(db, "ADM011", "staffer@dailychoicezone.com", "staff", [])
        assert client.get("/api/admin/support/lookups", headers=admin_login(client, staff)).status_code == 200
