"""
ID lookup (docs/id-lookup.md): suggestions match identifiers only, a pick is
resolved exactly, and nobody finds a record they could not already open.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy.exc import OperationalError

from app.api.routes import lookup as lookup_routes
from app.models import Order, Product

pytestmark = pytest.mark.integration


def _order(db, *, order_id: str, number: str, customer_id: str = "CUS001") -> Order:
    order = Order(
        id=order_id, order_number=number, customer_id=customer_id, customer_name="Asha Rao",
        customer_email="shopper@example.com", placed_at=datetime(2026, 1, 1), status="confirmed",
        payment_status="paid", payment_method="upi", delivery_method="standard", expected_delivery="",
        item_count=1, subtotal=100, catalogue_savings=0, coupon_discount=0, delivery_fee=0, tax_amount=0,
        total=100, shipping_name="Asha", shipping_phone="1", shipping_line1="l", shipping_line2="",
        shipping_city="c", shipping_state="s", shipping_pincode="560001", shipping_country="India",
    )
    db.add(order)
    db.flush()
    return order


def _product(db, product_id: str, sku: str, name: str = "Running Shoes") -> Product:
    product = Product(
        id=product_id, slug=f"p-{product_id.lower()}", sku=sku, name=name, brand="Stride",
        category_id="CAT001", subcategory="shoes", price=999.0, original_price=999.0, discount=0,
        stock=25, status="active",
    )
    db.add(product)
    db.flush()
    return product


def _ids(response) -> list:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["data"]["items"]]


def _admin_token(client, admin_user) -> dict:
    response = client.post("/api/admin/auth/login", json={"email": admin_user.email, "password": "Admin@123"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


# -------------------------------------------------------------- suggestions


class TestSuggestions:
    def test_a_prefix_lists_matching_ids_in_order(self, client, admin_auth, catalogue):
        assert _ids(client.get("/api/admin/lookup/product?q=PRD00", headers=admin_auth)) == [
            "PRD001", "PRD002", "PRD003", "PRD004"]

    def test_suggestions_carry_identifiers_and_nothing_else(self, client, admin_auth, catalogue):
        data = client.get("/api/admin/lookup/product?q=PRD", headers=admin_auth).json()["data"]
        assert data["idLabel"] == "Product ID"
        for item in data["items"]:
            assert set(item) <= {"id", "match"}

    @pytest.mark.parametrize("term", ["cotton", "Cotton Kurta", "shoe", "Anvi", "women", "kurta"])
    def test_names_brands_and_slugs_never_match(self, client, admin_auth, catalogue, db, term):
        _product(db, "PRD010", "DCZ-SH0010", name="Running Shoes")
        assert _ids(client.get(f"/api/admin/lookup/product?q={term}", headers=admin_auth)) == []

    def test_case_does_not_matter(self, client, admin_auth, catalogue):
        assert _ids(client.get("/api/admin/lookup/product?q=prd001", headers=admin_auth)) == ["PRD001"]

    def test_dashes_in_a_business_id_are_ignored(self, client, admin_auth, catalogue):
        assert _ids(client.get("/api/admin/lookup/product?q=PRD-00", headers=admin_auth))[:1] == ["PRD001"]

    def test_bare_digits_try_the_prefix_and_its_padding(self, client, admin_auth, catalogue):
        assert _ids(client.get("/api/admin/lookup/product?q=3", headers=admin_auth)) == ["PRD003"]
        assert _ids(client.get("/api/admin/lookup/product?q=002", headers=admin_auth)) == ["PRD002"]

    def test_a_sku_finds_the_product_and_says_why(self, client, admin_auth, catalogue):
        items = client.get("/api/admin/lookup/product?q=DCZ-EL", headers=admin_auth).json()["data"]["items"]
        assert items == [{"id": "PRD003", "match": "DCZ-EL0003"}]

    def test_an_exact_hit_ranks_first(self, client, admin_auth, catalogue, db):
        _product(db, "PRD0010", "X-1")
        assert _ids(client.get("/api/admin/lookup/product?q=PRD001", headers=admin_auth))[0] == "PRD001"

    def test_empty_query_returns_nothing(self, client, admin_auth, catalogue):
        assert _ids(client.get("/api/admin/lookup/product?q=", headers=admin_auth)) == []
        assert _ids(client.get("/api/admin/lookup/product?q=%20%20", headers=admin_auth)) == []

    def test_results_are_capped_and_say_there_are_more(self, client, admin_auth, catalogue, db):
        for n in range(10, 35):
            _product(db, f"PRD{n:03d}", f"BULK-{n}")
        data = client.get("/api/admin/lookup/product?q=PRD0", headers=admin_auth).json()["data"]
        assert len(data["items"]) == 10 and data["hasMore"] is True
        data = client.get("/api/admin/lookup/product?q=PRD0&limit=20", headers=admin_auth).json()["data"]
        assert len(data["items"]) == 20 and data["hasMore"] is True
        data = client.get("/api/admin/lookup/product?q=PRD03&limit=20", headers=admin_auth).json()["data"]
        assert len(data["items"]) == 5 and data["hasMore"] is False

    @pytest.mark.parametrize("limit", [0, 21, -1])
    def test_a_limit_out_of_range_is_refused(self, client, admin_auth, catalogue, limit):
        response = client.get(f"/api/admin/lookup/product?q=PRD&limit={limit}", headers=admin_auth)
        assert response.status_code == 422
        assert response.json()["error_code"] == "LOOKUP_BAD_LIMIT"

    def test_an_order_is_found_by_number_or_id(self, client, admin_auth, customer, db):
        _order(db, order_id="ORD100", number="DCZ90100")
        assert _ids(client.get("/api/admin/lookup/order?q=DCZ901", headers=admin_auth)) == ["DCZ90100"]
        items = client.get("/api/admin/lookup/order?q=ORD10", headers=admin_auth).json()["data"]["items"]
        assert items == [{"id": "DCZ90100", "match": "ORD100"}]
        # The running number alone, as a customer reads it out.
        assert _ids(client.get("/api/admin/lookup/order?q=90100", headers=admin_auth)) == ["DCZ90100"]

    def test_customer_names_and_emails_never_find_an_order(self, client, admin_auth, customer, db):
        _order(db, order_id="ORD100", number="DCZ90100")
        for term in ("Asha", "shopper", "Rao"):
            assert _ids(client.get(f"/api/admin/lookup/order?q={term}", headers=admin_auth)) == []
        # An email is not an ID at all.
        response = client.get("/api/admin/lookup/order?q=shopper@example.com", headers=admin_auth)
        assert response.status_code == 422

    def test_a_customer_is_found_by_id_not_by_name_or_email(self, client, admin_auth, customer):
        assert _ids(client.get("/api/admin/lookup/customer?q=CUS", headers=admin_auth)) == ["CUS001"]
        assert _ids(client.get("/api/admin/lookup/customer?q=Asha", headers=admin_auth)) == []
        assert _ids(client.get("/api/admin/lookup/customer?q=9876500001", headers=admin_auth)) == []

    def test_repeated_requests_agree(self, client, admin_auth, catalogue):
        """Read-only and deterministic: the same query, asked again and again, answers the same."""
        answers = {tuple(_ids(client.get("/api/admin/lookup/product?q=PRD", headers=admin_auth))) for _ in range(5)}
        assert len(answers) == 1


# ------------------------------------------------------------ bad input


class TestBadInput:
    @pytest.mark.parametrize("term", ["' OR 1=1 --", "PRD001;DROP TABLE products", "%", "PRD%", "<script>", "a b!"])
    def test_text_no_id_could_contain_is_refused(self, client, admin_auth, catalogue, term):
        response = client.get("/api/admin/lookup/product", params={"q": term}, headers=admin_auth)
        assert response.status_code == 422
        body = response.json()
        assert body["success"] is False and body["error_code"] == "LOOKUP_INVALID_ID"
        assert "Product ID" in body["message"]

    def test_like_wildcards_inside_an_id_are_literal(self, client, admin_auth, catalogue):
        # "_" is a legal ID character but must not act as LIKE's any-character.
        assert _ids(client.get("/api/admin/lookup/product?q=PRD_0", headers=admin_auth)) == []

    def test_an_over_long_query_is_refused(self, client, admin_auth, catalogue):
        response = client.get("/api/admin/lookup/product", params={"q": "P" * 65}, headers=admin_auth)
        assert response.status_code == 422

    def test_tables_survive_an_injection_attempt(self, client, admin_auth, catalogue, db):
        client.get("/api/admin/lookup/product/PRD001';DROP TABLE products;--", headers=admin_auth)
        assert db.get(Product, "PRD001") is not None

    def test_an_unknown_entity_is_404(self, client, admin_auth):
        response = client.get("/api/admin/lookup/spaceship?q=X", headers=admin_auth)
        assert response.status_code == 404
        assert response.json()["error_code"] == "LOOKUP_UNKNOWN_ENTITY"


# -------------------------------------------------------- exact selection


class TestResolve:
    def test_the_exact_id_returns_its_main_details(self, client, admin_auth, catalogue):
        data = client.get("/api/admin/lookup/product/PRD001", headers=admin_auth).json()["data"]
        assert data["id"] == "PRD001" and data["entity"] == "product"
        assert data["title"] == "Cotton Kurta" and data["status"] == "active"
        fields = {f["label"]: f for f in data["fields"]}
        assert fields["Price"] == {"label": "Price", "value": 100000, "format": "money"}
        assert fields["Stock"]["value"] == 10
        assert {"entity": "category", "id": "CAT001", "label": "Category"} in data["related"]

    def test_an_exact_pick_never_returns_a_longer_id(self, client, admin_auth, catalogue, db):
        _product(db, "PRD0010", "LONGER-1", name="Longer")
        assert client.get("/api/admin/lookup/product/PRD001", headers=admin_auth).json()["data"]["title"] == "Cotton Kurta"
        assert client.get("/api/admin/lookup/product/PRD0010", headers=admin_auth).json()["data"]["title"] == "Longer"

    def test_a_prefix_is_not_an_id(self, client, admin_auth, catalogue):
        response = client.get("/api/admin/lookup/product/PRD00", headers=admin_auth)
        assert response.status_code == 404
        body = response.json()
        assert body["error_code"] == "LOOKUP_NOT_FOUND"
        assert body["message"] == "Product ID PRD00 was not found."

    def test_a_non_existent_id_names_the_entity(self, client, admin_auth, catalogue):
        body = client.get("/api/admin/lookup/order/DCZ99999", headers=admin_auth).json()
        assert body["message"] == "Order ID DCZ99999 was not found."

    def test_lower_case_and_dashes_resolve_the_same_record(self, client, admin_auth, catalogue):
        assert client.get("/api/admin/lookup/product/prd-001", headers=admin_auth).json()["data"]["id"] == "PRD001"

    def test_an_order_resolves_by_number_or_id(self, client, admin_auth, customer, db):
        _order(db, order_id="ORD100", number="DCZ90100")
        for key in ("DCZ90100", "ORD100"):
            data = client.get(f"/api/admin/lookup/order/{key}", headers=admin_auth).json()["data"]
            assert data["id"] == "DCZ90100" and data["key"] == "ORD100"
            assert {"entity": "customer", "id": "CUS001", "label": "Customer"} in data["related"]

    def test_a_blank_id_is_a_validation_error(self, client, admin_auth, catalogue):
        response = client.get("/api/admin/lookup/product/%20", headers=admin_auth)
        assert response.status_code == 422
        assert response.json()["error_code"] == "LOOKUP_EMPTY_ID"

    def test_a_malformed_id_is_a_validation_error(self, client, admin_auth, catalogue):
        response = client.get("/api/admin/lookup/product/PRD 001!", headers=admin_auth)
        assert response.status_code == 422
        assert response.json()["message"].startswith("Invalid Product ID")

    def test_the_customer_preview_shows_no_secrets(self, client, admin_auth, customer):
        data = client.get("/api/admin/lookup/customer/CUS001", headers=admin_auth).json()["data"]
        text = repr(data)
        assert "password" not in text.lower() and "$2b$" not in text
        assert {f["label"] for f in data["fields"]} >= {"Email", "Orders", "Total spent"}

    def test_a_database_failure_is_a_clean_error(self, client, admin_auth, catalogue, db, monkeypatch):
        def broken(*args, **kwargs):
            raise OperationalError("SELECT", {}, Exception("server has gone away"))

        monkeypatch.setattr(db, "execute", broken)
        response = client.get("/api/admin/lookup/product/PRD001", headers=admin_auth)
        assert response.status_code >= 500
        body = response.json()
        assert body["success"] is False
        assert "gone away" not in body["message"] and "Traceback" not in response.text


# ------------------------------------------------------------ who may ask


class TestAuthorisation:
    def test_no_token_is_401(self, client, catalogue):
        assert client.get("/api/admin/lookup/product?q=PRD").status_code == 401
        assert client.get("/api/admin/lookup/product/PRD001").status_code == 401
        assert client.get("/api/account/lookup/order?q=DCZ").status_code == 401

    def test_a_customer_token_cannot_use_the_portal_lookup(self, client, auth, catalogue):
        response = client.get("/api/admin/lookup/product/PRD001", headers=auth)
        assert response.status_code == 403

    def test_a_role_without_customers_cannot_look_customers_up(self, client, editor, customer):
        headers = _admin_token(client, editor)
        for path in ("/api/admin/lookup/customer?q=CUS", "/api/admin/lookup/customer/CUS001",
                     "/api/admin/lookup/address/ADR001"):
            response = client.get(path, headers=headers)
            assert response.status_code == 403, path
            assert response.json()["error_code"] == "PERMISSION_DENIED"

    def test_the_same_role_can_look_up_what_it_may_open(self, client, editor, catalogue):
        headers = _admin_token(client, editor)
        assert _ids(client.get("/api/admin/lookup/product?q=PRD001", headers=headers)) == ["PRD001"]

    def test_support_tickets_follow_the_desk_rule(self, client, editor):
        headers = _admin_token(client, editor)  # not an agent, no `support`
        assert client.get("/api/admin/lookup/ticket?q=DCZ", headers=headers).status_code == 403

    def test_the_entity_list_and_global_search_leave_out_what_a_role_cannot_open(self, client, editor, customer,
                                                                                     catalogue):
        headers = _admin_token(client, editor)
        entities = {e["entity"] for e in client.get("/api/admin/lookup/entities", headers=headers).json()["data"]["items"]}
        assert "product" in entities and "customer" not in entities and "ticket" not in entities
        groups = client.get("/api/admin/lookup?q=CUS", headers=headers).json()["data"]["groups"]
        assert all(group["entity"] != "customer" for group in groups)

    def test_too_many_lookups_are_slowed_down(self, client, admin_auth, catalogue, monkeypatch):
        monkeypatch.setattr(lookup_routes, "_PER_MINUTE", 3)
        codes = [client.get("/api/admin/lookup/product?q=PRD", headers=admin_auth).status_code for _ in range(4)]
        assert codes == [200, 200, 200, 429]


# ---------------------------------------------------------- global search


class TestEverywhere:
    def test_groups_by_entity_and_matches_ids_only(self, client, admin_auth, catalogue, customer, db):
        _order(db, order_id="ORD100", number="DCZ90100")
        data = client.get("/api/admin/lookup?q=PRD", headers=admin_auth).json()["data"]
        assert [g["entity"] for g in data["groups"]] == ["product"]
        assert data["total"] == 3  # three per entity by default
        data = client.get("/api/admin/lookup?q=Cotton", headers=admin_auth).json()["data"]
        assert data["groups"] == [] and data["total"] == 0

    def test_a_single_character_is_too_short(self, client, admin_auth, catalogue):
        assert client.get("/api/admin/lookup?q=P", headers=admin_auth).json()["data"]["groups"] == []

    def test_an_order_number_is_found_from_anywhere(self, client, admin_auth, customer, db):
        _order(db, order_id="ORD100", number="DCZ90100")
        groups = client.get("/api/admin/lookup?q=DCZ901", headers=admin_auth).json()["data"]["groups"]
        assert {g["entity"]: [i["id"] for i in g["items"]] for g in groups}["order"] == ["DCZ90100"]


# --------------------------------------------------------------- customers


class TestCustomerLookup:
    def test_a_customer_finds_only_their_own_orders(self, client, auth, customer, other_customer, db):
        _order(db, order_id="ORD100", number="DCZ90100")
        _order(db, order_id="ORD101", number="DCZ90101", customer_id="CUS002")
        assert _ids(client.get("/api/account/lookup/order?q=DCZ9010", headers=auth)) == ["DCZ90100"]

    def test_someone_elses_order_is_not_found(self, client, auth, customer, other_customer, db):
        _order(db, order_id="ORD101", number="DCZ90101", customer_id="CUS002")
        response = client.get("/api/account/lookup/order/DCZ90101", headers=auth)
        assert response.status_code == 404
        assert response.json()["message"] == "Order ID DCZ90101 was not found."

    def test_their_own_order_resolves_without_portal_links(self, client, auth, customer, db):
        _order(db, order_id="ORD100", number="DCZ90100")
        data = client.get("/api/account/lookup/order/DCZ90100", headers=auth).json()["data"]
        assert data["id"] == "DCZ90100" and data["related"] == []

    def test_their_address_by_id(self, client, auth, customer):
        assert _ids(client.get("/api/account/lookup/address?q=ADR", headers=auth)) == ["ADR001"]

    def test_portal_entities_are_not_customer_entities(self, client, auth, catalogue):
        for path in ("/api/account/lookup/product?q=PRD", "/api/account/lookup/customer/CUS001"):
            response = client.get(path, headers=auth)
            assert response.status_code == 404
            assert response.json()["error_code"] == "LOOKUP_UNKNOWN_ENTITY"

    def test_an_admin_token_cannot_use_the_customer_lookup(self, client, admin_auth):
        assert client.get("/api/account/lookup/order?q=DCZ", headers=admin_auth).status_code == 403


# ------------------------------------------------------ list ID filters


class TestIdCondition:
    def test_keeps_exactly_the_named_rows(self, db, catalogue, customer):
        from sqlalchemy import select

        from app.services.lookup.filters import any_id_condition, id_condition

        _product(db, "PRD0010", "LONG-1")
        _order(db, order_id="ORD100", number="DCZ90100")

        def ids(condition):
            return sorted(db.execute(select(Product.id).where(condition)).scalars())

        assert ids(id_condition("product", "prd-001")) == ["PRD001"]
        assert ids(id_condition("product", "DCZ-WO0002")) == ["PRD002"]
        assert ids(id_condition("product", "Cotton")) == []
        assert ids(id_condition("product", "a@b.com")) == []  # not an ID at all: nothing, not an error
        assert id_condition("product", "  ") is None

        orders = select(Order.id).where(id_condition("customer", "CUS001", column=Order.customer_id))
        assert list(db.execute(orders).scalars()) == ["ORD100"]
        either = any_id_condition("DCZ90100", ("order", None, None), ("customer", Order.customer_id, None))
        assert list(db.execute(select(Order.id).where(either)).scalars()) == ["ORD100"]


# ------------------------------------------------------------- every entity


@pytest.mark.parametrize("key", sorted(__import__("app.services.lookup", fromlist=["ADMIN_ENTITIES"]).ADMIN_ENTITIES))
def test_every_entity_suggests_and_resolves_without_error(client, admin_auth, key):
    """Each registry entry's columns are real and queryable: a suggestion answers, a missing ID is a 404."""
    suggest = client.get(f"/api/admin/lookup/{key}?q=9", headers=admin_auth)
    assert suggest.status_code == 200, suggest.text
    assert all(set(item) <= {"id", "match"} for item in suggest.json()["data"]["items"])
    missing = client.get(f"/api/admin/lookup/{key}/ZZZ999999", headers=admin_auth)
    assert missing.status_code == 404, missing.text
    assert missing.json()["error_code"] == "LOOKUP_NOT_FOUND"


class TestLaterEntities:
    """Stock adjustments, packing jobs, reconciliations, referral codes and support agents."""

    @pytest.fixture
    def records(self, db, catalogue, customer):
        from app.models.catalogue import StockAdjustment
        from app.models.fulfilment import PackingJob
        from app.models.growth import ReferralCode
        from app.models.reconciliation import PaymentReconciliation
        from app.models.support import SupportAgent

        now = datetime.utcnow()
        order = _order(db, order_id="ORD100", number="DCZ90100")
        adjustment = StockAdjustment(product_id="PRD001", reason="restock", quantity_before=5, quantity_after=10,
                                     delta=5, note="Delivery", actor="ADM001", created_at=now)
        job = PackingJob(order_id=order.id, status="pending", priority="high")
        check = PaymentReconciliation(gateway_payment_id="pay_ABC123", order_number="DCZ90100", status="mismatch",
                                      summary="Amount differs", amount=10000, checked_at=now, created_at=now,
                                      updated_at=now)
        code = ReferralCode(customer_id="CUS001", code="ASHA2026", created_at=now)
        agent = SupportAgent(name="Ravi Kumar", email="ravi@example.com", created_at=now, updated_at=now)
        db.add_all([adjustment, job, check, code, agent])
        db.flush()
        return {"stock_adjustment": adjustment, "packing_job": job, "reconciliation": check, "agent": agent}

    def _preview(self, client, admin_auth, key, identifier):
        response = client.get(f"/api/admin/lookup/{key}/{identifier}", headers=admin_auth)
        assert response.status_code == 200, response.text
        return response.json()["data"]

    def test_each_resolves_to_its_main_details(self, client, admin_auth, records):
        adjustment = self._preview(client, admin_auth, "stock_adjustment", records["stock_adjustment"].id)
        assert adjustment["subtitle"] == "restock"
        assert {(r["entity"], r["id"]) for r in adjustment["related"]} == {("product", "PRD001"), ("admin_user", "ADM001")}

        job = self._preview(client, admin_auth, "packing_job", records["packing_job"].id)
        assert job["status"] == "pending" and {"entity": "order", "id": "DCZ90100", "label": "Order"} in job["related"]

        check = self._preview(client, admin_auth, "reconciliation", records["reconciliation"].id)
        assert check["status"] == "mismatch"
        assert {f["label"]: f["value"] for f in check["fields"]}["Amount"] == 10000
        assert "local" not in check and "gateway" not in check  # raw payment snapshots stay out

        code = self._preview(client, admin_auth, "referral_code", "asha2026")
        assert code["id"] == "ASHA2026" and code["related"] == [{"entity": "customer", "id": "CUS001", "label": "Customer"}]

        agent = self._preview(client, admin_auth, "support_agent", records["agent"].id)
        assert agent["title"] == "Ravi Kumar" and agent["status"] == "active"

    def test_a_reconciliation_is_found_by_its_gateway_payment_id(self, client, admin_auth, records):
        response = client.get("/api/admin/lookup/reconciliation?q=pay_ABC", headers=admin_auth)
        items = response.json()["data"]["items"]
        assert items == [{"id": str(records["reconciliation"].id), "match": "PAY_ABC123"}] or \
            items == [{"id": str(records["reconciliation"].id), "match": "pay_ABC123"}]
        resolved = self._preview(client, admin_auth, "reconciliation", "pay_ABC123")
        assert resolved["id"] == str(records["reconciliation"].id)

    def test_an_agent_is_found_by_id_never_by_name_or_email(self, client, admin_auth, records):
        agent_id = str(records["agent"].id)
        assert agent_id in _ids(client.get(f"/api/admin/lookup/support_agent?q={agent_id}", headers=admin_auth))
        assert _ids(client.get("/api/admin/lookup/support_agent?q=Ravi", headers=admin_auth)) == []
        assert client.get("/api/admin/lookup/support_agent?q=ravi@example.com", headers=admin_auth).status_code == 422

    def test_each_needs_its_own_permission(self, client, editor, records):
        headers = _admin_token(client, editor)  # products, content, questions, bundles, search
        assert client.get(f"/api/admin/lookup/stock_adjustment/{records['stock_adjustment'].id}",
                          headers=headers).status_code == 200
        for key in ("packing_job", "reconciliation", "referral_code", "support_agent"):
            response = client.get(f"/api/admin/lookup/{key}?q=1", headers=headers)
            assert response.status_code == 403, key
