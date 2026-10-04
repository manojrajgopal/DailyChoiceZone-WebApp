"""
Reviews and product questions: the paths the main suites leave out.

Reviews had no integration tests of their own: writing one, the verified
badge derived from real orders, the rating summary the product page draws,
and moderation recomputing the product's stars. Questions add the less common
moderation moves -- re-approving, rejecting an answered question, editing and
unpublishing answers -- and the admin filters.
"""

from __future__ import annotations

import pytest

from app.core import rate_limit
from app.models import Product, ProductAnswer, ProductQuestion, Review
from tests.integration.test_questions import QUESTION, public
from tests.integration.wallet_helpers import fill_bag, place

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture()
def mailbox(monkeypatch):
    """Every email queued, respecting preferences the way the real `notify` does."""
    from app.services import email as email_service

    sent = []

    def record(db, key, *, to, customer_id, subject, html, text, reference="", **_):
        if not email_service.wants(db, key, customer_id):
            return False
        sent.append({"key": key, "to": to, "subject": subject, "html": html, "reference": reference})
        return True

    monkeypatch.setattr(email_service, "notify", record)
    return sent


def write_review(client, auth, product="PRD001", rating=5, title="Lovely fabric", body="Soft, breathable and true to size."):
    return client.post("/api/reviews", headers=auth,
                       json={"productId": product, "rating": rating, "title": title, "body": body})


def other_auth(client, other_customer) -> dict:
    token = client.post("/api/auth/login", json={"email": other_customer.email, "password": "Customer@123"})
    assert token.status_code == 200, token.text
    return {"Authorization": f"Bearer {token.json()['data']['token']['accessToken']}"}


# ======================================================================== reviews


class TestWritingAReview:
    def test_a_review_arrives_pending_and_unverified(self, client, db, auth, catalogue):
        response = write_review(client, auth)
        assert response.status_code == 201, response.text
        body = response.json()
        assert body["success"] is True
        data = body["data"]
        assert data["productId"] == "PRD001"
        assert data["author"] == "Asha R"
        assert data["rating"] == 5 and data["verified"] is False
        assert "status" not in data and "customerId" not in data
        stored = db.get(Review, data["id"])
        assert stored.status == "pending" and stored.customer_id == "CUS001"
        # Pending: the product page shows nothing yet.
        assert client.get("/api/reviews?productId=PRD001").json()["data"] == []

    def test_title_and_body_are_trimmed(self, client, db, auth, catalogue):
        data = write_review(client, auth, title="   Nice kurta   ", body="   Wears well after washing.   ").json()["data"]
        assert data["title"] == "Nice kurta" and data["body"] == "Wears well after washing."

    def test_a_delivered_order_makes_the_review_verified(self, client, db, auth, catalogue, settings_documents):
        from app.models import Order

        fill_bag(client, auth, "PRD001", 1)
        order_id = place(client, auth, method="cod")["order"]["id"]
        db.get(Order, order_id).status = "delivered"
        db.flush()
        assert write_review(client, auth).json()["data"]["verified"] is True

    def test_an_order_not_yet_shipped_does_not_verify(self, client, db, auth, catalogue, settings_documents):
        fill_bag(client, auth, "PRD001", 1)
        place(client, auth, method="cod")
        assert write_review(client, auth).json()["data"]["verified"] is False

    def test_one_review_per_product_per_customer(self, client, auth, catalogue):
        assert write_review(client, auth).status_code == 201
        again = write_review(client, auth, title="Second thoughts")
        assert again.status_code == 409
        assert again.json()["error_code"] == "REVIEW_EXISTS"

    def test_an_unknown_product_is_a_404(self, client, auth, catalogue):
        response = write_review(client, auth, product="PRD999")
        assert response.status_code == 404
        assert response.json()["error_code"] == "PRODUCT_NOT_FOUND"

    def test_writing_needs_an_account(self, client, catalogue):
        response = client.post("/api/reviews", json={"productId": "PRD001", "rating": 5, "title": "Lovely",
                                                     "body": "Soft and breathable."})
        assert response.status_code == 401

    @pytest.mark.parametrize("field, value", [
        ("rating", 0), ("rating", 6), ("title", "ab"), ("body", "short"),
    ])
    def test_out_of_range_input_is_a_422(self, client, auth, catalogue, field, value):
        payload = {"productId": "PRD001", "rating": 4, "title": "Lovely", "body": "Soft and breathable.", field: value}
        response = client.post("/api/reviews", headers=auth, json=payload)
        assert response.status_code == 422
        assert response.json()["success"] is False


class TestTheSummary:
    def test_an_unreviewed_product_has_an_empty_summary(self, client, catalogue):
        response = client.get("/api/reviews/summary?productId=PRD001")
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["average"] == 0.0 and data["total"] == 0
        assert [row["stars"] for row in data["distribution"]] == [5, 4, 3, 2, 1]
        assert all(row["count"] == 0 for row in data["distribution"])

    def test_the_summary_counts_only_approved_reviews(self, client, db, catalogue, customer, other_customer):
        from datetime import datetime

        db.add_all([
            Review(id="REV901", product_id="PRD001", customer_id="CUS001", author="Asha R", rating=5,
                   title="Great", body="Great kurta", status="approved", submitted_at=datetime(2026, 2, 1)),
            Review(id="REV902", product_id="PRD001", customer_id="CUS002", author="Ravi N", rating=2,
                   title="Meh", body="Shrunk a bit", status="approved", submitted_at=datetime(2026, 2, 2)),
            Review(id="REV903", product_id="PRD001", customer_id=None, author="Anon", rating=1,
                   title="Spam", body="Buy elsewhere", status="pending", submitted_at=datetime(2026, 2, 3)),
        ])
        db.flush()
        data = client.get("/api/reviews/summary?productId=PRD001").json()["data"]
        assert data["total"] == 2
        assert data["average"] == 3.5
        counts = {row["stars"]: row["count"] for row in data["distribution"]}
        assert counts == {5: 1, 4: 0, 3: 0, 2: 1, 1: 0}
        listed = client.get("/api/reviews?productId=PRD001").json()["data"]
        # Newest first, pending left out.
        assert [r["id"] for r in listed] == ["REV902", "REV901"]
        assert listed[0]["date"] == "2026-02-02"

    def test_the_product_id_is_required(self, client, catalogue):
        assert client.get("/api/reviews/summary").status_code == 422


class TestModeratingReviews:
    def _pending(self, client, auth, **extra) -> str:
        response = write_review(client, auth, **extra)
        assert response.status_code == 201, response.text
        return response.json()["data"]["id"]

    def test_the_queue_lists_and_filters(self, client, auth, admin_auth, catalogue):
        review_id = self._pending(client, auth)
        everything = client.get("/api/admin/reviews", headers=admin_auth).json()["data"]
        assert [r["id"] for r in everything] == [review_id]
        assert everything[0]["status"] == "pending" and everything[0]["customerId"] == "CUS001"
        assert client.get("/api/admin/reviews?status=all", headers=admin_auth).json()["data"][0]["id"] == review_id
        assert client.get("/api/admin/reviews?status=approved", headers=admin_auth).json()["data"] == []
        assert len(client.get("/api/admin/reviews?status=pending", headers=admin_auth).json()["data"]) == 1

    def test_approving_publishes_and_moves_the_stars(self, client, db, auth, admin_auth, catalogue):
        review_id = self._pending(client, auth, rating=2)
        response = client.put(f"/api/admin/reviews/{review_id}", headers=admin_auth, json={"status": "approved"})
        assert response.status_code == 200
        assert response.json()["data"] == {"id": review_id, "status": "approved"}
        db.expire_all()
        product = db.get(Product, "PRD001")
        assert float(product.rating) == 2.0
        # The marketing review count is left alone.
        assert product.review_count == 2
        assert [r["id"] for r in client.get("/api/reviews?productId=PRD001").json()["data"]] == [review_id]

    def test_rejecting_hides_it_again(self, client, auth, admin_auth, catalogue):
        review_id = self._pending(client, auth)
        client.put(f"/api/admin/reviews/{review_id}", headers=admin_auth, json={"status": "approved"})
        client.put(f"/api/admin/reviews/{review_id}", headers=admin_auth, json={"status": "rejected"})
        assert client.get("/api/reviews?productId=PRD001").json()["data"] == []
        assert client.get("/api/reviews/summary?productId=PRD001").json()["data"]["total"] == 0

    def test_deleting_recomputes_the_rating_from_what_is_left(self, client, db, auth, admin_auth, catalogue,
                                                             other_customer):
        mine = self._pending(client, auth, rating=5)
        theirs = self._pending(client, other_auth(client, other_customer), rating=3)
        for review_id in (mine, theirs):
            client.put(f"/api/admin/reviews/{review_id}", headers=admin_auth, json={"status": "approved"})
        db.expire_all()
        assert float(db.get(Product, "PRD001").rating) == 4.0
        response = client.delete(f"/api/admin/reviews/{mine}", headers=admin_auth)
        assert response.status_code == 200
        db.expire_all()
        assert db.get(Review, mine) is None
        assert float(db.get(Product, "PRD001").rating) == 3.0

    def test_an_unknown_review(self, client, admin_auth, catalogue):
        put = client.put("/api/admin/reviews/REV999", headers=admin_auth, json={"status": "approved"})
        assert put.status_code == 404 and put.json()["error_code"] == "REVIEW_NOT_FOUND"
        assert client.delete("/api/admin/reviews/REV999", headers=admin_auth).status_code == 404

    def test_a_customer_cannot_moderate(self, client, auth, catalogue):
        review_id = self._pending(client, auth)
        assert client.put(f"/api/admin/reviews/{review_id}", headers=auth,
                          json={"status": "approved"}).status_code in (401, 403)
        assert client.delete(f"/api/admin/reviews/{review_id}", headers=auth).status_code in (401, 403)

    def test_an_editor_without_the_permission_cannot_moderate(self, client, auth, editor, catalogue):
        review_id = self._pending(client, auth)
        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"}
                            ).json()["data"]["token"]["accessToken"]
        response = client.put(f"/api/admin/reviews/{review_id}", headers={"Authorization": f"Bearer {token}"},
                              json={"status": "approved"})
        assert response.status_code == 403

    def test_recomputing_a_missing_product_is_harmless(self, db, catalogue):
        from app.services import reviews

        reviews._recompute_product_rating(db, "PRD999")  # no product, no error

    # Regression: was a real bug, fixed alongside this test.
    def test_an_unknown_moderation_status_is_refused(self, client, db, auth, admin_auth, catalogue):
        review_id = self._pending(client, auth)
        response = client.put(f"/api/admin/reviews/{review_id}", headers=admin_auth, json={"status": "banana"})
        assert response.status_code == 422


# ====================================================================== questions


def question_id(client, auth, text=QUESTION, **extra) -> int:
    response = client.post("/api/products/cotton-kurta/questions", headers=auth, json={"question": text, **extra})
    assert response.status_code == 201, response.text
    return response.json()["data"]["id"]


def answer(client, admin_auth, qid, text="It is pre-washed.", **extra):
    return client.put(f"/api/admin/questions/{qid}/answer", headers=admin_auth, json={"answer": text, **extra})


class TestAskingVariants:
    def test_a_size_and_colour_the_product_has_are_kept(self, client, db, auth, catalogue, mailbox):
        from app.models import ProductColor, ProductSize

        db.add_all([ProductSize(product_id="PRD001", label="M", position=0),
                    ProductColor(product_id="PRD001", name="Indigo", hex="#123456", position=0)])
        db.flush()
        qid = question_id(client, auth, size="M", color="Indigo")
        stored = db.get(ProductQuestion, qid)
        assert (stored.size, stored.color) == ("M", "Indigo")

    def test_a_size_and_colour_it_does_not_have_are_dropped(self, client, db, auth, catalogue, mailbox):
        qid = question_id(client, auth, size="XXL", color="Neon")
        stored = db.get(ProductQuestion, qid)
        assert (stored.size, stored.color) == ("", "")

    def test_a_blocked_customer_is_not_emailed(self, db, customer, catalogue, mailbox):
        from app.services import questions

        customer.status = "blocked"
        db.flush()
        question = questions.ask(db, customer, "PRD001", QUESTION)
        assert question.status == "pending"
        assert [m for m in mailbox if m["key"] == questions.EMAIL_TYPE] == []

    def test_the_mine_list_needs_a_listed_product(self, client, auth, catalogue):
        response = client.get("/api/products/draft-jacket/questions/mine", headers=auth)
        assert response.status_code == 404
        assert response.json()["error_code"] == "PRODUCT_NOT_FOUND"


class TestModerationEdges:
    def test_approving_twice_changes_nothing(self, client, db, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        client.post(f"/api/admin/questions/{qid}/approve", headers=admin_auth)
        before = len(mailbox)
        again = client.post(f"/api/admin/questions/{qid}/approve", headers=admin_auth)
        assert again.status_code == 200
        assert [e["action"] for e in again.json()["data"]["events"]] == ["asked", "approved"]
        assert len(mailbox) == before

    def test_rejecting_twice_changes_nothing(self, client, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        client.post(f"/api/admin/questions/{qid}/reject", headers=admin_auth, json={"reason": "Off topic"})
        again = client.post(f"/api/admin/questions/{qid}/reject", headers=admin_auth, json={"reason": "Other"})
        assert again.status_code == 200
        data = again.json()["data"]
        assert data["rejectionReason"] == "Off topic"
        assert [e["action"] for e in data["events"]] == ["asked", "rejected"]

    def test_rejecting_an_answered_question_takes_the_answer_down(self, client, db, auth, admin_auth, catalogue,
                                                                  mailbox):
        qid = question_id(client, auth)
        assert answer(client, admin_auth, qid, approve=True).status_code == 200
        assert public(client)["answered"] == 1
        response = client.post(f"/api/admin/questions/{qid}/reject", headers=admin_auth, json={"reason": "Spam"})
        assert response.status_code == 200
        assert response.json()["data"]["answer"]["published"] is False
        assert public(client)["items"] == [] and public(client)["answered"] == 0

    def test_approving_with_a_published_answer_announces_the_answer(self, client, db, auth, admin_auth, catalogue,
                                                                    mailbox):
        qid = question_id(client, auth)
        answer(client, admin_auth, qid, approve=True)
        # A question put back in the queue while its answer stays live.
        db.get(ProductQuestion, qid).status = "pending"
        db.flush()
        mailbox.clear()
        client.post(f"/api/admin/questions/{qid}/approve", headers=admin_auth)
        subjects = [m["subject"] for m in mailbox if m["key"] == "product_questions"]
        assert len(subjects) == 1 and "answered" in subjects[0]

    def test_an_unknown_action_is_refused(self, db, admin, catalogue, customer, mailbox):
        from app.core.errors import ValidationError
        from app.services import questions

        question = questions.ask(db, customer, "PRD001", QUESTION)
        with pytest.raises(ValidationError) as caught:
            questions.moderate(db, question.id, admin, action="shelve")
        assert caught.value.error_code == "INVALID_ACTION"

    def test_an_unknown_question_is_a_404(self, client, admin_auth, catalogue):
        response = client.get("/api/admin/questions/999999", headers=admin_auth)
        assert response.status_code == 404
        assert response.json()["error_code"] == "QUESTION_NOT_FOUND"
        assert client.post("/api/admin/questions/999999/approve", headers=admin_auth).status_code == 404


class TestAnswers:
    def test_an_empty_answer_is_refused(self, client, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        response = answer(client, admin_auth, qid, "<b></b>x", approve=True)
        assert response.status_code == 422 and response.json()["error_code"] == "ANSWER_TOO_SHORT"

    def test_an_overlong_answer_is_refused(self, client, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        response = answer(client, admin_auth, qid, "y" * 2500, approve=True)
        assert response.status_code == 422 and response.json()["error_code"] == "ANSWER_TOO_LONG"

    def test_a_rejected_question_cannot_be_answered(self, client, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        client.post(f"/api/admin/questions/{qid}/reject", headers=admin_auth, json={"reason": ""})
        response = answer(client, admin_auth, qid, approve=True)
        assert response.status_code == 409 and response.json()["error_code"] == "QUESTION_REJECTED"

    def test_approving_with_a_draft_answer_says_it_is_live(self, client, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        mailbox.clear()
        response = answer(client, admin_auth, qid, "Draft words", publish=False, approve=True)
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["status"] == "approved" and data["answer"]["published"] is False
        assert [e["action"] for e in data["events"]] == ["asked", "approved", "answer-drafted"]
        subjects = [m["subject"] for m in mailbox if m["key"] == "product_questions"]
        assert len(subjects) == 1 and "is live" in subjects[0]

    def test_a_draft_is_published_edited_and_unpublished(self, client, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        client.post(f"/api/admin/questions/{qid}/approve", headers=admin_auth)
        answer(client, admin_auth, qid, "First draft", publish=False)
        assert public(client)["answered"] == 0

        published = answer(client, admin_auth, qid, "First draft", publish=True).json()["data"]
        assert published["answer"]["published"] is True and published["answer"]["publishedAt"]
        assert public(client)["answered"] == 1

        edited = answer(client, admin_auth, qid, "Better words").json()["data"]
        assert edited["answer"]["body"] == "Better words"

        unpublished = answer(client, admin_auth, qid, "Better words", publish=False).json()["data"]
        assert unpublished["answer"]["published"] is False
        assert public(client)["answered"] == 0
        assert [e["action"] for e in unpublished["events"]] == [
            "asked", "approved", "answer-drafted", "answered", "answer-edited", "answer-unpublished"]

    def test_saving_the_same_published_answer_adds_no_history(self, client, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        answer(client, admin_auth, qid, "Same words", approve=True)
        again = answer(client, admin_auth, qid, "Same words").json()["data"]
        assert [e["action"] for e in again["events"]] == ["asked", "approved", "answered"]

    def test_answered_only_lists_just_the_answered(self, db, client, auth, admin_auth, catalogue, mailbox):
        from app.services import questions

        first = question_id(client, auth)
        second = question_id(client, auth, "How long are the sleeves on this one?")
        client.post(f"/api/admin/questions/{second}/approve", headers=admin_auth)
        answer(client, admin_auth, first, approve=True)
        items, total, answered = questions.list_public(db, "PRD001", answered_only=True)
        assert total == 1 and answered == 1 and [q["id"] for q in items] == [first]
        everything, total, _ = questions.list_public(db, "PRD001")
        # Answered first.
        assert total == 2 and [q["id"] for q in everything] == [first, second]


class TestEditing:
    def test_an_edit_must_stay_within_the_length(self, client, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        response = client.put(f"/api/admin/questions/{qid}", headers=admin_auth, json={"question": "Short"})
        assert response.status_code == 422 and response.json()["error_code"] == "QUESTION_LENGTH"

    def test_an_unchanged_edit_is_not_history(self, client, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        response = client.put(f"/api/admin/questions/{qid}", headers=admin_auth, json={"question": QUESTION})
        assert response.status_code == 200
        assert [e["action"] for e in response.json()["data"]["events"]] == ["asked"]

    def test_deleting_an_unknown_question(self, client, admin_auth, catalogue):
        assert client.delete("/api/admin/questions/999999", headers=admin_auth).status_code == 404


class TestAdminFilters:
    def test_unanswered_by_product_and_by_customer(self, client, db, auth, admin_auth, catalogue, mailbox,
                                                   other_customer):
        mine = question_id(client, auth)
        theirs = question_id(client, other_auth(client, other_customer), "Is the colour fast in hot water?")
        answer(client, admin_auth, mine, approve=True)

        def total(query):
            response = client.get(f"/api/admin/questions?{query}", headers=admin_auth)
            assert response.status_code == 200, response.text
            return response.json()["data"]

        assert [i["id"] for i in total("answered=no")["items"]] == [theirs]
        assert total("productId=PRD001")["pagination"]["total"] == 2
        assert total("productId=PRD002")["pagination"]["total"] == 0
        by_customer = total("customerId=CUS002")
        assert [i["id"] for i in by_customer["items"]] == [theirs]
        assert by_customer["items"][0]["customer"]["email"] == other_customer.email
        assert total("productId=DCZ-WO0001")["pagination"]["total"] == 2  # the SKU is an identifier too
        assert total(f"q={theirs}")["pagination"]["total"] == 1
        assert total(f"q={theirs}&customerId=CUS001")["pagination"]["total"] == 0
        # Names, emails and SKUs are not Question IDs; the text box searches only the wording.
        # ("Cotton" is only in the product's name, "Asha" only in the customer's.)
        for query in ("q=Asha", "q=DCZ-WO0001", f"q={other_customer.email}", "customerId=Asha",
                      "productId=Kurta", "text=Asha", "text=Cotton", "productId=PRD00",
                      "productId=PRD0010", "customerId=CUS0011", "customerId=%27%3B%20DROP",
                      "q=%27%3B%20DROP"):
            assert total(query)["pagination"]["total"] == 0, query
        assert total("text=colour")["pagination"]["total"] == 1
        assert total("text=kurta")["pagination"]["total"] == 1  # the wording itself, not the product's name
        counts = total("")["counts"]
        assert counts["approved"] == 1 and counts["pending"] == 1 and counts["unanswered"] == 0

    def test_pending_count(self, db, client, auth, catalogue, mailbox):
        from app.services import questions

        question_id(client, auth)
        assert questions.pending_count(db) == 1

    def test_a_question_about_a_deleted_customer_still_shows(self, client, db, auth, admin_auth, catalogue, mailbox):
        qid = question_id(client, auth)
        db.get(ProductQuestion, qid).customer_id = None
        db.flush()
        detail = client.get(f"/api/admin/questions/{qid}", headers=admin_auth).json()["data"]
        assert detail["customer"] is None and detail["product"]["id"] == "PRD001"
        # Moderating a question with nobody to email still works.
        assert client.post(f"/api/admin/questions/{qid}/approve", headers=admin_auth).status_code == 200
        assert db.query(ProductAnswer).count() == 0
