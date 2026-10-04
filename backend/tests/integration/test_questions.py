"""Product questions: asking, moderation, answers, what the storefront shows, and abuse protection."""

from __future__ import annotations

import pytest

from app.core import rate_limit
from app.models import ProductQuestion

pytestmark = pytest.mark.integration

QUESTION = "Does this kurta shrink after the first wash?"


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def mailbox(monkeypatch):
    from app.services import email as email_service

    sent = []

    def record(db, key, *, to, customer_id, subject, html, text, reference="", **_):
        if not email_service.wants(db, key, customer_id):
            return False
        sent.append({"key": key, "to": to, "subject": subject, "html": html})
        return True

    monkeypatch.setattr(email_service, "notify", record)
    return sent


def ask(client, auth, text=QUESTION, product="cotton-kurta"):
    return client.post(f"/api/products/{product}/questions", headers=auth, json={"question": text})


def public(client, product="cotton-kurta"):
    return client.get(f"/api/products/{product}/questions").json()["data"]


class TestAsking:
    def test_a_question_waits_for_moderation(self, client, auth, catalogue, mailbox):
        response = ask(client, auth)
        assert response.status_code == 201, response.text
        assert response.json()["data"]["status"] == "pending"
        assert public(client)["items"] == []
        mine = client.get("/api/products/cotton-kurta/questions/mine", headers=auth).json()["data"]
        assert mine[0]["status"] == "pending"
        assert mailbox[0]["subject"].startswith("We've got your question")

    def test_signing_in_is_required(self, client, catalogue):
        assert client.post("/api/products/cotton-kurta/questions", json={"question": QUESTION}).status_code == 401

    def test_markup_is_stripped_and_text_kept(self, client, db, auth, catalogue, mailbox):
        ask(client, auth, '<script>alert(1)</script>Is the <b>cotton</b> soft &amp; breathable?')
        stored = db.query(ProductQuestion).one().body
        assert "<" not in stored and stored == "alert(1)Is the cotton soft & breathable?"
        assert "<script>" not in mailbox[0]["html"]

    @pytest.mark.parametrize("text, code", [
        ("Too short", "QUESTION_TOO_SHORT"),
        ("x" * 501, "QUESTION_TOO_LONG"),
        ("Is this cheaper at https://example.com today?", "QUESTION_HAS_LINK"),
        ("Visit www.cheap-kurtas.com for a better deal please", "QUESTION_HAS_LINK"),
    ])
    def test_bad_questions_are_refused(self, client, auth, catalogue, text, code):
        response = ask(client, auth, text)
        assert response.status_code == 422 and response.json()["error_code"] == code

    def test_the_same_question_twice_is_refused(self, client, auth, catalogue, mailbox):
        ask(client, auth)
        again = ask(client, auth, "does this KURTA shrink after the first wash")
        assert again.status_code == 409 and again.json()["error_code"] == "DUPLICATE_QUESTION"

    def test_asking_is_rate_limited(self, client, auth, catalogue, mailbox):
        codes = [ask(client, auth, f"Question number {i} about the fabric weight?").status_code for i in range(6)]
        assert codes[:5] == [201] * 5 and codes[5] == 429

    def test_unlisted_products_take_no_questions(self, client, auth, catalogue):
        assert ask(client, auth, product="draft-jacket").status_code == 404


class TestModeration:
    def _question(self, client, auth):
        return ask(client, auth).json()["data"]["id"]

    def test_approve_publishes(self, client, auth, admin_auth, catalogue, mailbox):
        question_id = self._question(client, auth)
        response = client.post(f"/api/admin/questions/{question_id}/approve", headers=admin_auth)
        assert response.status_code == 200
        items = public(client)["items"]
        assert items[0]["question"] == QUESTION and items[0]["answer"] is None
        assert items[0]["author"] == "Asha R."
        assert any("is live" in m["subject"] for m in mailbox)

    def test_answering_publishes_and_tells_the_customer(self, client, auth, admin_auth, catalogue, mailbox):
        question_id = self._question(client, auth)
        refused = client.put(f"/api/admin/questions/{question_id}/answer", headers=admin_auth,
                             json={"answer": "No — it's pre-washed."})
        assert refused.status_code == 409 and refused.json()["error_code"] == "QUESTION_PENDING"
        answered = client.put(f"/api/admin/questions/{question_id}/answer", headers=admin_auth,
                              json={"answer": "No — it's pre-washed.", "approve": True})
        assert answered.status_code == 200
        item = public(client)["items"][0]
        assert item["answer"]["body"] == "No — it's pre-washed." and item["answer"]["by"] == "Manoj Rajan"
        assert public(client)["answered"] == 1
        answered_mail = [m for m in mailbox if "answered" in m["subject"]]
        assert len(answered_mail) == 1 and "pre-washed" in answered_mail[0]["html"]

    def test_a_draft_answer_is_not_shown(self, client, auth, admin_auth, catalogue, mailbox):
        question_id = self._question(client, auth)
        client.post(f"/api/admin/questions/{question_id}/approve", headers=admin_auth)
        client.put(f"/api/admin/questions/{question_id}/answer", headers=admin_auth,
                   json={"answer": "Draft words", "publish": False})
        assert public(client)["items"][0]["answer"] is None

    def test_reject_with_a_reason(self, client, auth, admin_auth, catalogue, mailbox):
        question_id = self._question(client, auth)
        response = client.post(f"/api/admin/questions/{question_id}/reject", headers=admin_auth,
                               json={"reason": "Please contact support about orders."})
        assert response.json()["data"]["status"] == "rejected"
        assert public(client)["items"] == []
        mine = client.get("/api/products/cotton-kurta/questions/mine", headers=auth).json()["data"]
        assert mine[0]["rejectionReason"] == "Please contact support about orders."
        assert any(m["subject"].startswith("About your question") for m in mailbox)

    def test_history_edit_and_delete(self, client, auth, admin_auth, catalogue, mailbox):
        question_id = self._question(client, auth)
        client.put(f"/api/admin/questions/{question_id}", headers=admin_auth,
                   json={"question": "Does this kurta shrink when washed?"})
        client.post(f"/api/admin/questions/{question_id}/approve", headers=admin_auth)
        detail = client.get(f"/api/admin/questions/{question_id}", headers=admin_auth).json()["data"]
        assert [e["action"] for e in detail["events"]] == ["asked", "edited", "approved"]
        assert detail["events"][1]["by"] == "Manoj Rajan"
        assert client.delete(f"/api/admin/questions/{question_id}", headers=admin_auth).status_code == 200
        assert public(client)["items"] == []

    def test_filters(self, client, auth, admin_auth, catalogue, mailbox):
        first = self._question(client, auth)
        ask(client, auth, "What is the length of the medium size?")
        client.put(f"/api/admin/questions/{first}/answer", headers=admin_auth, json={"answer": "Yes.", "approve": True})
        data = client.get("/api/admin/questions?status=pending", headers=admin_auth).json()["data"]
        assert data["pagination"]["total"] == 1 and data["counts"]["pending"] == 1
        assert client.get("/api/admin/questions?answered=yes", headers=admin_auth).json()["data"]["pagination"]["total"] == 1
        assert client.get("/api/admin/questions?text=length", headers=admin_auth).json()["data"]["pagination"]["total"] == 1
        assert [i["id"] for i in client.get(f"/api/admin/questions?q={first}", headers=admin_auth)
                .json()["data"]["items"]] == [first]

    def test_preferences_are_respected(self, client, auth, admin_auth, catalogue, mailbox):
        client.put("/api/account/email-preferences", headers=auth, json={"product_questions": False})
        question_id = self._question(client, auth)
        client.post(f"/api/admin/questions/{question_id}/approve", headers=admin_auth)
        # Nothing to the customer; the store team's alert about a new question still goes.
        assert [m for m in mailbox if m["key"] != "store_team"] == []

    def test_who_may_moderate(self, client, auth, editor, catalogue, mailbox):
        question_id = self._question(client, auth)
        assert client.post(f"/api/admin/questions/{question_id}/approve", headers=auth).status_code in (401, 403)
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        # Editors moderate questions by role, even with an older stored permission list.
        response = client.post(f"/api/admin/questions/{question_id}/approve",
                               headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
