"""
The clock and the numbers: SLA warnings, escalation rules, the sweeper's
failure handling and its background loop, the SLA badge each ticket shows,
the support dashboard's aggregates, who hears about a ticket, and the
in-app notification bell (`services.inbox`).
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timedelta

import pytest

from tests.integration.test_email import connect, outbox  # noqa: F401 -- fixture
from tests.integration.test_support import (  # noqa: F401 -- fixtures
    _fresh_limits,
    add_agent,
    raise_ticket,
    support,
    team_id,
)

pytestmark = pytest.mark.integration

DESK = "/api/admin/support/tickets"


@pytest.fixture(autouse=True)
def _no_mail(outbox):  # noqa: F811
    return outbox


def ticket_row(db, number):
    from app.models import SupportTicket

    db.expire_all()
    return db.query(SupportTicket).filter_by(number=number).one()


def raised(client, auth, db, *path, **fields):
    response = raise_ticket(client, auth, *path, **fields)
    assert response.status_code == 201, response.text
    return ticket_row(db, response.json()["data"]["ticket"]["number"])


def save_settings(client, admin_auth, payload):
    response = client.put("/api/admin/support/config/settings", headers=admin_auth, json=payload)
    assert response.status_code == 200, response.text


# ------------------------------------------------------------------ the sweep


class TestWarningsAndRules:
    def test_a_warning_once_most_of_the_window_has_gone(self, client, auth, admin, support, db):
        from app.models import Notification
        from app.services.support import sla

        row = raised(client, auth, db, "Orders", "Order Status")
        assert row.priority == "medium"
        early = row.created_at + timedelta(hours=10)
        assert sla.sweep(db, now=early) == 0
        late = row.created_at + timedelta(hours=20)  # 83% of a 24-hour window
        assert sla.sweep(db, now=late) == 1
        row = ticket_row(db, row.number)
        assert row.sla_warned and not row.sla_breached
        assert [e.kind for e in row.events].count("sla-warning") == 1
        assert any("due soon" in n.title for n in db.query(Notification).all())
        assert sla.sweep(db, now=late + timedelta(minutes=5)) == 0

    def test_an_unresolved_rule_fires_after_its_delay_and_only_once(self, client, auth, admin_auth, support, db):
        from app.services.support import sla

        save_settings(client, admin_auth, {"escalation": [
            {"id": "slow", "label": "Half an hour without resolution", "when": "unresolved", "afterMinutes": 30,
             "notify": "admins"}]})
        row = raised(client, auth, db, "Orders", "Order Status")
        assert sla.sweep(db, now=row.created_at + timedelta(minutes=29)) == 0
        assert sla.sweep(db, now=row.created_at + timedelta(minutes=31)) == 1
        row = ticket_row(db, row.number)
        assert row.status == "escalated" and row.escalation_level == 1 and row.escalations_applied == ["slow"]
        assert any(e.kind == "escalated" and e.note == "Half an hour without resolution" for e in row.events)
        assert sla.sweep(db, now=row.created_at + timedelta(minutes=60)) == 0

    def test_rules_wait_while_the_customer_is_answering(self, client, auth, admin_auth, support, db):
        from app.services.support import sla

        save_settings(client, admin_auth, {"escalation": [
            {"id": "slow", "when": "unresolved", "afterMinutes": 1, "notify": "admins"}]})
        row = raised(client, auth, db, "Orders", "Order Status")
        client.post(f"{DESK}/{row.id}/messages", headers=admin_auth,
                    data={"body": "Which address?", "status": "waiting-customer"})
        assert sla.sweep(db, now=row.created_at + timedelta(days=3)) == 0
        assert ticket_row(db, row.number).escalation_level == 0

    @pytest.mark.parametrize("rule, fields, expected", [
        ({"when": "unresolved", "priorities": ["urgent"]}, {"priority": "low"}, False),
        ({"when": "unresolved", "priorities": ["low"]}, {"priority": "low"}, True),
        ({"when": "no-response"}, {"first_response_at": "now"}, False),
        ({"when": "no-response", "afterMinutes": 120}, {}, False),
        ({"when": "no-response", "afterMinutes": 30}, {}, True),
        ({"when": "sla-breached"}, {"sla_breached": False}, False),
        ({"when": "sla-breached", "afterMinutes": 30}, {"sla_breached": True}, False),
        ({"when": "sla-breached"}, {"sla_breached": True}, True),
        ({"when": "on-a-tuesday"}, {}, False),
    ])
    def test_when_a_rule_applies(self, rule, fields, expected):
        from app.models import SupportTicket
        from app.services.support import sla

        now = datetime(2026, 10, 1, 12, 0)
        values = {"priority": "medium", "created_at": now - timedelta(hours=1), "first_response_at": None,
                  "sla_breached": False, "resolve_due_at": now - timedelta(minutes=10)}
        values.update({k: (now if v == "now" else v) for k, v in fields.items()})
        assert sla._rule_applies(SupportTicket(**values), rule, now) is expected

    def test_a_ticket_without_a_target_is_only_checked_against_rules(self, support, db):
        from app.models import SupportTicket
        from app.services.support import sla

        ticket = SupportTicket(status="assigned", resolve_due_at=None, created_at=datetime(2026, 1, 1),
                               escalations_applied=[], sla_warned=False, sla_breached=False)
        assert sla.check(db, ticket, datetime(2026, 1, 2), {"escalation": []}) is False


class TestTheSweeperKeepsGoing:
    def test_one_failing_ticket_does_not_stop_the_rest(self, client, auth, support, db, monkeypatch, caplog):
        from app.services.support import sla

        first = raised(client, auth, db, "Orders", "Order Status")
        second = raised(client, auth, db, "Orders", "Missing Item")
        real = sla.check

        def flaky(db_, ticket, now, conf):
            if ticket.id == first.id:
                raise RuntimeError("boom")
            return real(db_, ticket, now, conf)

        monkeypatch.setattr(sla, "check", flaky)
        later = max(first.resolve_due_at, second.resolve_due_at) + timedelta(minutes=1)
        assert sla.sweep(db, now=later) == 1
        assert ticket_row(db, second.number).sla_breached is True
        assert ticket_row(db, first.number).sla_breached is False
        assert "SLA check failed" in caplog.text

    def test_auto_close_can_be_switched_off(self, client, auth, admin_auth, support, db):
        from app.services.support import sla

        save_settings(client, admin_auth, {"autoCloseResolvedDays": 0})
        row = raised(client, auth, db, "Orders", "Order Status")
        client.put(f"{DESK}/{row.id}/status", headers=admin_auth, json={"status": "resolved"})
        row = ticket_row(db, row.number)
        row.resolved_at = datetime.utcnow() - timedelta(days=60)
        db.flush()
        sla.sweep(db)
        assert ticket_row(db, row.number).status == "resolved"

    def test_a_failed_auto_close_is_logged_and_left_for_next_time(self, client, auth, admin_auth, support, db,
                                                                   monkeypatch, caplog):
        from app.services.support import sla
        from app.services.support import tickets as ticket_service

        row = raised(client, auth, db, "Orders", "Order Status")
        client.put(f"{DESK}/{row.id}/status", headers=admin_auth, json={"status": "resolved"})
        row = ticket_row(db, row.number)
        row.resolved_at = datetime.utcnow() - timedelta(days=10)
        db.flush()

        def refuse(*args, **kwargs):
            raise RuntimeError("locked")

        monkeypatch.setattr(ticket_service, "set_status", refuse)
        assert sla.sweep(db) == 0
        assert ticket_row(db, row.number).status == "resolved"
        assert "Auto-close failed" in caplog.text

    def test_the_closing_note_says_how_long_it_waited(self, client, auth, admin_auth, support, db):
        from app.services.support import sla

        row = raised(client, auth, db, "Orders", "Order Status")
        client.put(f"{DESK}/{row.id}/status", headers=admin_auth, json={"status": "resolved"})
        row = ticket_row(db, row.number)
        row.resolved_at = datetime.utcnow() - timedelta(days=6)
        db.flush()
        assert sla.sweep(db) == 1
        row = ticket_row(db, row.number)
        assert row.status == "closed"
        assert any(e.note == "Closed automatically 5 days after it was resolved." for e in row.events)


class TestTheBackgroundLoop:
    def test_one_pass_uses_its_own_session(self, monkeypatch, db):
        from app.core import database
        from app.services.support import sla

        seen = []
        monkeypatch.setattr(database, "SessionLocal", lambda: contextlib.nullcontext(db))
        monkeypatch.setattr(sla, "sweep", lambda session: seen.append(session))
        sla._sweep_once()
        assert seen == [db]

    def test_the_loop_survives_a_failure_and_stops_when_cancelled(self, monkeypatch, caplog):
        from app.services import jobs
        from app.services.support import sla

        calls = []

        def tracked(name, interval, fn):
            calls.append((name, interval))
            if len(calls) == 1:
                raise RuntimeError("database away")

            def cancelled():
                raise asyncio.CancelledError()

            return cancelled

        async def no_wait(seconds):
            calls.append(("sleep", seconds))

        async def inline(fn, *args):
            # Run the pass on the loop itself: a CancelledError raised in a
            # worker thread does not reliably reach the awaiting task.
            return fn(*args)

        monkeypatch.setattr(jobs, "tracked", tracked)
        monkeypatch.setattr(sla.asyncio, "sleep", no_wait)
        monkeypatch.setattr(sla.asyncio, "to_thread", inline)
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(sla.run_forever())
        assert calls == [("support_sla", 60), ("sleep", 60), ("support_sla", 60)]
        assert "retrying next interval" in caplog.text


# -------------------------------------------------------------- the badge


def ticket(**fields):
    from app.models import SupportTicket

    now = datetime.utcnow()
    values = {"status": "in-progress", "created_at": now - timedelta(hours=1),
              "resolve_due_at": now + timedelta(hours=23), "sla_breached": False,
              "resolved_at": None, "closed_at": None}
    values.update(fields)
    return SupportTicket(**values)


class TestTheSlaBadge:
    def test_no_target(self):
        from app.services.support.tickets import sla_state

        assert sla_state(ticket(resolve_due_at=None)) == {"state": "none", "dueAt": None, "minutesLeft": None}

    def test_finished_tickets_are_met_or_breached(self):
        from app.services.support.tickets import sla_state

        now = datetime.utcnow()
        due = now - timedelta(hours=1)
        assert sla_state(ticket(status="resolved", resolve_due_at=due, resolved_at=due - timedelta(minutes=1)))[
            "state"] == "met"
        assert sla_state(ticket(status="resolved", resolve_due_at=due, resolved_at=now))["state"] == "breached"
        assert sla_state(ticket(status="closed", resolve_due_at=due, closed_at=due - timedelta(hours=1),
                                sla_breached=True))["state"] == "breached"
        assert sla_state(ticket(status="closed", resolve_due_at=now + timedelta(hours=1),
                                closed_at=now))["minutesLeft"] is None

    def test_open_tickets(self):
        from app.services.support.tickets import sla_state

        now = datetime.utcnow()
        paused = sla_state(ticket(status="waiting-customer", resolve_due_at=now - timedelta(minutes=90)), now=now)
        assert paused["state"] == "paused" and paused["minutesLeft"] == -90
        assert sla_state(ticket(sla_breached=True))["state"] == "breached"
        late = sla_state(ticket(resolve_due_at=now - timedelta(minutes=1)), now=now)
        assert late["state"] == "breached" and late["minutesLeft"] < 0
        assert sla_state(ticket(created_at=now - timedelta(hours=20), resolve_due_at=now + timedelta(hours=4)),
                         now=now)["state"] == "due-soon"
        assert sla_state(ticket(), now=now)["state"] == "on-track"

    def test_the_warning_share_comes_from_settings(self, client, admin_auth, support, db):
        from app.services.support.tickets import sla_state

        now = datetime.utcnow()
        row = ticket(created_at=now - timedelta(hours=3), resolve_due_at=now + timedelta(hours=21))
        assert sla_state(row, db, now)["state"] == "on-track"
        save_settings(client, admin_auth, {"slaWarningPercent": 10})
        assert sla_state(row, db, now)["state"] == "due-soon"
        assert sla_state(row, None, now)["state"] == "on-track"


# ---------------------------------------------------------------- dashboard


class TestTheDashboard:
    @pytest.fixture()
    def history(self, client, auth, admin_auth, support, db):
        add_agent(client, admin_auth, "Asha Agent", "Customer Support")
        fast = raised(client, auth, db, "Orders", "Order Status")
        late = raised(client, auth, db, "Payments", "Payment Failed")
        still_open = raised(client, auth, db, "Account", "Account Security")
        client.post(f"{DESK}/{fast.id}/messages", headers=admin_auth, data={"body": "Done.", "status": "resolved"})
        client.put(f"{DESK}/{late.id}/status", headers=admin_auth, json={"status": "resolved"})
        late = ticket_row(db, late.number)
        late.resolve_due_at = late.resolved_at - timedelta(hours=1)
        db.flush()
        client.post(f"/api/support/tickets/{fast.number}/feedback", headers=auth, json={"rating": 5, "comment": "Great"})
        client.post(f"/api/support/tickets/{late.number}/feedback", headers=auth, json={"rating": 2})
        return {"fast": fast, "late": late, "open": still_open}

    def test_the_numbers(self, client, admin_auth, history):
        response = client.get("/api/admin/support/dashboard?days=7", headers=admin_auth)
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["days"] == 7 and len(data["overTime"]) == 8
        assert data["overTime"][-1]["created"] == 3 and data["overTime"][-1]["resolved"] == 2
        totals = data["totals"]
        assert (totals["total"], totals["resolved"], totals["urgent"], totals["createdInRange"]) == (3, 2, 1, 3)
        assert totals["open"] + totals["inProgress"] == 1
        assert data["slaCompliance"] == 50.0
        assert data["avgFirstResponseMinutes"] is not None and data["avgResolutionMinutes"] is not None
        satisfaction = data["satisfaction"]
        assert satisfaction["average"] == 3.5 and satisfaction["count"] == 2
        assert satisfaction["positivePercent"] == 50.0
        assert [d["value"] for d in satisfaction["distribution"]] == [1, 0, 0, 1, 0]
        assert [r["comment"] for r in satisfaction["recent"]] == ["Great"]
        agents = {a["label"]: a for a in data["byAgent"]}
        assert agents["Asha Agent"]["rating"] == 5.0 and agents["Asha Agent"]["total"] == 2
        assert agents["Unassigned"]["rating"] == 2.0
        assert {p["label"]: p["value"] for p in data["byPriority"]} == {"Urgent": 1, "High": 0, "Medium": 2,
                                                                          "Low": 0}
        assert {c["label"]: c["value"] for c in data["byChannel"]} == {"form": 3}
        assert {t["label"] for t in data["byTeam"]} == {"Customer Support", "Payments & Finance"}
        assert client.get("/api/admin/support/dashboard?days=0", headers=admin_auth).status_code == 422

    def test_a_scope_narrows_tickets_and_ratings(self, client, admin_auth, history, db):
        from app.services.support import analytics

        support_team = team_id(client, admin_auth, "Customer Support")
        scoped = analytics.dashboard(db, team_ids=[support_team])
        assert scoped["totals"]["total"] == 2
        assert scoped["satisfaction"]["average"] == 5.0 and scoped["satisfaction"]["count"] == 1
        nothing = analytics.dashboard(db, team_ids=[], agent_id=None)
        assert nothing["totals"]["total"] == 0 and nothing["satisfaction"]["average"] is None
        assert nothing["slaCompliance"] is None and nothing["avgFirstResponseMinutes"] is None


# ----------------------------------------------------------- who hears what


class TestWhoHears:
    def test_a_team_inbox_hears_about_unassigned_tickets(self, client, auth, admin_auth, support, outbox):  # noqa: F811
        connect(client, admin_auth)
        team = team_id(client, admin_auth, "Customer Support")
        client.put(f"/api/admin/support/config/teams/{team}", headers=admin_auth,
                   json={"name": "Customer Support", "notifyEmail": "desk@staff.example.com"})
        outbox.clear()
        raise_ticket(client, auth, "Orders", "Order Status")
        assert "desk@staff.example.com" in {m["to"] for m in outbox}

    def test_a_switched_off_owner_is_skipped_and_the_super_admin_hears(self, client, auth, admin_auth, admin,
                                                                       support, db):
        from app.models import Notification, SupportAgent
        from app.services.support import notify

        agent = add_agent(client, admin_auth, "Old Owner", "Customer Support")
        row = raised(client, auth, db, "Orders", "Order Status")
        assert row.agent_id == agent["id"]
        db.get(SupportAgent, agent["id"]).active = False
        db.flush()
        before = db.query(Notification).filter_by(admin_id=admin.id).count()
        notify.staff(db, row, "customer_replied", title="Ping")
        db.flush()
        assert db.query(Notification).filter_by(admin_id=admin.id).count() == before + 1

    def test_the_third_escalation_goes_to_the_super_admins(self, client, auth, admin_auth, admin, support, db):
        from app.models import Notification

        row = raised(client, auth, db, "Orders", "Order Status")
        for reason in ("first time", "second time", "third time"):
            response = client.post(f"{DESK}/{row.id}/escalate", headers=admin_auth, json={"reason": reason})
            assert response.status_code == 200
        assert response.json()["data"]["escalationLevel"] == 3
        # The super admin escalated it themselves, but no lead or other admin exists, so they hear of it.
        titles = [n.title for n in db.query(Notification).filter_by(admin_id=admin.id).all()]
        assert titles.count(f"{row.number} escalated") == 3

    def test_a_missing_date_reads_as_a_dash_and_a_missing_template_sends_nothing(self, support, db, monkeypatch):
        from app.models import SupportTicket
        from app.services.support import notify

        assert notify._when(db, None) == "—"
        assert notify.team_agents(db, None) == []
        sent = []
        monkeypatch.setattr("app.services.email.notify", lambda *a, **k: sent.append(k))
        row = SupportTicket(number="DCZ-2026-999999", customer_id=None, team_id=None, agent_id=None)
        notify._send(db, "no_such_template", row, "someone@example.com", {"ticket_url": ""}, internal=True)
        notify._send(db, "ticket_created", row, "", {"ticket_url": ""}, internal=False)
        assert sent == []


# ---------------------------------------------------------------- the bell


class TestTheBell:
    def test_nobody_to_tell(self, db):
        from app.models import CustomerNotification
        from app.services import inbox

        inbox.customer(db, None, "order", "Shipped")
        inbox.customer(db, "", "order", "Shipped")
        assert db.query(CustomerNotification).count() == 0

    def test_the_same_unread_news_is_shown_once(self, db, customer):
        from app.models import CustomerNotification
        from app.services import inbox

        inbox.customer(db, customer.id, "order", "  Shipped  ", "Your parcel left", "/account/orders")
        inbox.customer(db, customer.id, "order", "Shipped", "Your parcel left", "/account/orders")
        rows = db.query(CustomerNotification).filter_by(customer_id=customer.id).all()
        assert len(rows) == 1 and rows[0].title == "Shipped"
        rows[0].read = True
        db.flush()
        inbox.customer(db, customer.id, "order", "Shipped", "Your parcel left", "/account/orders")
        assert db.query(CustomerNotification).filter_by(customer_id=customer.id).count() == 2

    def test_a_failing_email_never_breaks_the_tray(self, db, monkeypatch, caplog):
        from app.models import Notification
        from app.services import inbox

        def broken(*args):
            raise RuntimeError("smtp down")

        monkeypatch.setattr(inbox, "_email_staff", broken)
        inbox.staff(db, "question", "A new question", "Body", "/admin/questions")
        db.flush()
        assert db.query(Notification).filter_by(kind="question").count() == 1
        assert "Could not email the store team" in caplog.text

    @pytest.fixture()
    def mail(self, monkeypatch):
        from app.services import email as email_service

        sent = []
        monkeypatch.setattr(email_service, "wants", lambda db, key, customer_id: True)
        monkeypatch.setattr(email_service, "notify", lambda db, key, **k: sent.append(k))
        return sent

    def test_staff_are_emailed_by_permission(self, db, admin, editor, mail):
        from app.services import inbox

        inbox._email_staff(db, "Order trouble", "Details", "/admin/orders", "orders")
        assert [m["to"] for m in mail] == [admin.email]
        mail.clear()
        inbox._email_staff(db, "New article", "Details", "", "content")
        assert {m["to"] for m in mail} == {admin.email, editor.email}
        assert all(m["customer_id"] is None and m["reference"] == "store-team" for m in mail)

    def test_nothing_when_the_store_team_mail_is_off(self, db, admin, monkeypatch, mail):
        from app.services import email as email_service
        from app.services import inbox

        monkeypatch.setattr(email_service, "wants", lambda db, key, customer_id: False)
        inbox._email_staff(db, "Anything", "", "", None)
        assert mail == []

    def test_the_sending_mailbox_hears_when_nobody_else_can(self, db, admin, monkeypatch, mail):
        from types import SimpleNamespace

        from app.services import email as email_service
        from app.services import inbox
        from app.services.email import senders

        monkeypatch.setattr(senders, "undeliverable", lambda address: "no mail server")
        monkeypatch.setattr(email_service, "active_account",
                            lambda db: SimpleNamespace(sender_email="Orders@Shop.example.com"))
        inbox._email_staff(db, "Alert", "Body", "", None)
        assert {m["to"] for m in mail} == {admin.email, "Orders@Shop.example.com"}

    def test_links_in_the_bell(self, monkeypatch):
        from app.core.config import settings
        from app.services import inbox

        base = settings.STOREFRONT_URL.rstrip("/")
        assert inbox._storefront_path("No links here") == ""
        assert inbox._storefront_path("Visit https://elsewhere.example.org/x now") == ""
        assert inbox._storefront_path(f"Reset at {base}/account/reset?token=abc&x=1.") == "/account/reset"
        assert inbox._storefront_path(f"See ({base}/account/orders?id=7#top).") == "/account/orders?id=7#top"
        assert inbox._storefront_path(f"Home {base}") == "/"

    def test_an_email_becomes_a_bell_entry(self, db, customer):
        from app.models import CustomerNotification
        from app.core.config import settings
        from app.services import inbox

        base = settings.STOREFRONT_URL.rstrip("/")
        inbox.from_email(db, "account_security", customer.id, "Reset", "x")
        inbox.from_email(db, "orders", customer.id, "Shipped", "x", inbox=False)
        inbox.from_email(db, "orders", None, "Shipped", "x")
        assert db.query(CustomerNotification).count() == 0

        text = "Your order: shipped. " + "word " * 60 + f" Track it at {base}/account/orders?id=9"
        inbox.from_email(db, "orders", customer.id, "Order shipped — Daily Choice Zone", text)
        row = db.query(CustomerNotification).one()
        assert row.title == "Order shipped" and row.href == "/account/orders?id=9"
        assert row.body.endswith("…") and len(row.body) == 221 and "http" not in row.body

        inbox.from_email(db, "offers", customer.id, "Ignored", "Ignored",
                         inbox={"title": "Custom", "body": "", "href": "/offers"})
        custom = db.query(CustomerNotification).filter_by(kind="offers").one()
        assert (custom.title, custom.body, custom.href) == ("Custom", "", "/offers")
