"""
After the order: returns and replacements past the main suite's paths
(malformed requests, stock that is not there for a replacement, a refund the
gateway refused once and is retried), and reordering a past order -- bundles
included -- when some of it has changed.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.core import rate_limit
from app.models import CartBundle, CartItem, Order, OrderEvent, OrderItem, Product, Refund, ReturnRequest
from tests.integration.test_bundles import add as add_bundle, make_bundle
from tests.integration.test_orders import someone_elses_order
from tests.integration.test_returns import ask, delivered, move, options  # noqa: F401
from tests.integration.wallet_helpers import fill_bag, place

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _fresh_limits():
    rate_limit.reset()
    yield
    rate_limit.reset()


def request_body(order_item_id, kind="return", quantity=1, **overrides):
    body = {"kind": kind, "reason": "Size or fit isn't right" if kind == "return" else "Wrong size delivered",
            "comment": "", "items": [{"orderItemId": order_item_id, "quantity": quantity}]}
    body.update(overrides)
    return body


def item_id(client, auth, order) -> int:
    return options(client, auth, order)["eligibility"]["items"][0]["orderItemId"]


# =================================================================== returns


class TestMalformedRequests:
    def test_the_same_line_twice_is_refused(self, client, auth, delivered):  # noqa: F811
        line = item_id(client, auth, delivered)
        body = request_body(line, items=[{"orderItemId": line, "quantity": 1}, {"orderItemId": line, "quantity": 1}])
        response = client.post(f"/api/orders/{delivered['id']}/returns", headers=auth, json=body)
        assert response.status_code == 422 and response.json()["error_code"] == "DUPLICATE_ITEM"

    def test_a_line_from_another_order_is_refused(self, client, db, auth, delivered):  # noqa: F811
        response = client.post(f"/api/orders/{delivered['id']}/returns", headers=auth, json=request_body(999999))
        assert response.status_code == 422 and response.json()["error_code"] == "ITEM_NOT_IN_ORDER"
        assert db.query(ReturnRequest).count() == 0

    @pytest.mark.parametrize("payload", [
        {"kind": "refund"}, {"items": []}, {"reason": ""}, {"items": [{"orderItemId": 1, "quantity": 0}]},
    ])
    def test_the_schema_refuses_the_rest(self, client, auth, delivered, payload):  # noqa: F811
        body = {**request_body(item_id(client, auth, delivered)), **payload}
        assert client.post(f"/api/orders/{delivered['id']}/returns", headers=auth, json=body).status_code == 422

    def test_the_service_checks_kind_owner_and_emptiness(self, db, customer, other_customer, delivered):  # noqa: F811
        from app.core.errors import NotFoundError, ValidationError
        from app.services import returns

        order = db.get(Order, delivered["id"])
        with pytest.raises(NotFoundError):
            returns.create(db, other_customer, order, kind="return", reason="Changed my mind", comment="", items=[])
        with pytest.raises(ValidationError) as caught:
            returns.create(db, customer, order, kind="swap", reason="Changed my mind", comment="", items=[])
        assert caught.value.error_code == "INVALID_KIND"
        with pytest.raises(ValidationError) as caught:
            returns.create(db, customer, order, kind="return", reason="Changed my mind", comment="", items=[])
        assert caught.value.error_code == "NO_ITEMS"


class TestReadingRequests:
    def test_the_customer_lists_their_own(self, client, auth, delivered):  # noqa: F811
        created = ask(client, auth, delivered).json()["data"]
        mine = client.get("/api/returns", headers=auth)
        assert mine.status_code == 200
        assert [r["id"] for r in mine.json()["data"]] == [created["id"]]
        assert mine.json()["data"][0]["canCancel"] is True

    def test_the_portal_reads_one_and_filters_the_list(self, client, auth, admin_auth, delivered):  # noqa: F811
        created = ask(client, auth, delivered).json()["data"]
        one = client.get(f"/api/admin/returns/{created['id']}", headers=admin_auth)
        assert one.status_code == 200
        assert one.json()["data"]["nextSteps"] == ["approved", "rejected", "cancelled"]
        assert one.json()["data"]["customerId"] == "CUS001"
        assert len(client.get("/api/admin/returns?status=requested&kind=return", headers=admin_auth)
                   .json()["data"]) == 1
        assert client.get("/api/admin/returns?kind=replacement", headers=admin_auth).json()["data"] == []
        assert client.get("/api/admin/returns?status=refunded", headers=admin_auth).json()["data"] == []

    def test_an_unknown_request(self, client, auth, admin_auth, catalogue):
        response = client.get("/api/admin/returns/RET999", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "RETURN_NOT_FOUND"
        assert client.post("/api/returns/RET999/cancel", headers=auth).status_code == 404

    def test_a_customer_cannot_use_the_portal(self, client, auth, delivered):  # noqa: F811
        assert client.get("/api/admin/returns", headers=auth).status_code in (401, 403)


class TestStockAndMoney:
    def test_receiving_a_return_relists_a_sold_out_product(self, client, db, auth, admin_auth, delivered):  # noqa: F811
        created = ask(client, auth, delivered, quantity=2).json()["data"]
        product = db.get(Product, "PRD001")
        product.stock, product.status = 0, "out-of-stock"
        db.flush()
        for status in ("approved", "received"):
            assert move(client, admin_auth, created["id"], status).status_code == 200
        db.expire_all()
        product = db.get(Product, "PRD001")
        assert product.stock == 2 and product.status == "active"

    def test_no_replacement_without_stock(self, client, db, auth, admin_auth, delivered):  # noqa: F811
        created = ask(client, auth, delivered, kind="replacement").json()["data"]
        for status in ("approved", "received"):
            move(client, admin_auth, created["id"], status)
        db.get(Product, "PRD001").stock = 0
        db.flush()
        response = move(client, admin_auth, created["id"], "replacement-shipped")
        assert response.status_code == 409 and response.json()["error_code"] == "INSUFFICIENT_STOCK"
        db.expire_all()
        assert db.get(ReturnRequest, created["id"]).status == "received"

    def test_a_refund_the_gateway_refused_is_retried_not_duplicated(self, client, db, auth, admin_auth, delivered,  # noqa: F811
                                                                    monkeypatch):
        from app.core.errors import ConflictError
        from app.services import invoices

        created = ask(client, auth, delivered).json()["data"]
        for status in ("approved", "received"):
            move(client, admin_auth, created["id"], status)
        real = invoices.set_refund_status

        def refuse(*args, **kwargs):
            raise ConflictError("Gateway refused the refund.", error_code="GATEWAY_REFUSED")

        monkeypatch.setattr(invoices, "set_refund_status", refuse)
        failed = move(client, admin_auth, created["id"], "refunded")
        assert failed.status_code == 409
        db.expire_all()
        request = db.get(ReturnRequest, created["id"])
        assert request.status == "received" and request.refund_id
        assert db.get(Refund, request.refund_id).status == "requested"

        monkeypatch.setattr(invoices, "set_refund_status", real)
        retried = move(client, admin_auth, created["id"], "refunded")
        assert retried.status_code == 200, retried.text
        db.expire_all()
        assert db.query(Refund).count() == 1
        assert db.query(Refund).one().status == "completed"

    def test_an_order_with_no_invoice_cannot_be_refunded(self, db, customer, admin, catalogue):
        from app.core.errors import ConflictError
        from app.services import returns

        order = someone_elses_order("ORD960", "DCZ960", customer)
        order.status = "delivered"
        order.items.append(OrderItem(product_id="PRD001", name="Cotton Kurta", quantity=1, unit_price=1000,
                                     line_total=1000))
        order.events.append(OrderEvent(status="delivered", note="", actor="system", occurred_at=datetime.utcnow()))
        db.add(order)
        db.flush()
        request = returns.create(db, customer, order, kind="return", reason="Changed my mind", comment="",
                                 items=[{"orderItemId": order.items[0].id, "quantity": 1}])
        assert request.amount == 100000  # from the order line, there being no invoice
        returns.update_status(db, request.id, "approved")
        returns.update_status(db, request.id, "received")
        with pytest.raises(ConflictError) as caught:
            returns.update_status(db, request.id, "refunded")
        assert caught.value.error_code == "NO_INVOICE"


class TestTheWindow:
    def test_a_broken_window_setting_falls_back_to_the_default(self, db, catalogue):
        from app.core.config import settings
        from app.models import SettingDocument
        from app.services import returns

        db.add(SettingDocument(key="store", value={"returns": {"windowDays": "a fortnight"}}))
        db.flush()
        assert returns.window_days(db) == settings.RETURN_WINDOW_DAYS

    def test_a_membership_with_a_broken_benefit_adds_nothing(self, db, customer, catalogue):
        from types import SimpleNamespace

        from app.services import returns

        assert returns._member_extra_days(db, SimpleNamespace(membership_id=None)) == 0
        assert returns._member_extra_days(db, SimpleNamespace(membership_id=999999)) == 0


# =================================================================== reorder


@pytest.fixture()
def shop(client, db, catalogue, customer, settings_documents, admin_auth, auth):
    db.add(Product(id="PRD005", slug="phone-stand", sku="DCZ-EL0005", name="Phone Stand", brand="Meridian",
                   category_id="CAT002", subcategory="accessories", price=500.0, original_price=500.0,
                   discount=0, stock=8, status="active", rating=0, review_count=0))
    db.flush()
    return client


def reorder_lines(client, auth, order_id) -> list:
    response = client.get(f"/api/orders/{order_id}/reorder", headers=auth)
    assert response.status_code == 200, response.text
    return response.json()["data"]["items"]


class TestReorderingABundle:
    @pytest.fixture()
    def bundle_order(self, shop, db, admin_auth, auth):
        bundle = make_bundle(shop, admin_auth)
        add_bundle(shop, auth, bundle["id"], 2)
        order = place(shop, auth, method="cod")["order"]
        assert db.query(CartBundle).count() == 0
        return bundle, order

    def test_a_bundle_bought_before_goes_back_as_that_bundle(self, shop, db, auth, bundle_order):
        bundle, order = bundle_order
        db.get(Product, "PRD002").stock = 10  # restocked since
        db.flush()
        lines = reorder_lines(shop, auth, order["id"])
        assert len(lines) == 1
        line = lines[0]
        assert line["kind"] == "bundle" and line["bundleId"] == bundle["id"] and line["orderedQuantity"] == 2
        assert line["status"] == "available" and line["quantity"] == 2 and line["currentPrice"] == 2999
        assert [c["quantity"] for c in line["components"]] == [1, 1, 2]
        response = shop.post(f"/api/orders/{order['id']}/reorder", headers=auth, json={})
        assert response.status_code == 200, response.text
        assert db.query(CartBundle).one().quantity == 2
        # Again: already in the bag.
        again = reorder_lines(shop, auth, order["id"])[0]
        assert again["status"] == "in_bag"

    def test_an_archived_bundle_cannot_come_back(self, shop, db, auth, bundle_order):
        from app.models import Bundle

        bundle, order = bundle_order
        db.get(Bundle, bundle["id"]).status = "archived"
        db.flush()
        line = reorder_lines(shop, auth, order["id"])[0]
        assert line["status"] == "bundle_unavailable" and line["quantity"] == 0

    def test_a_bundle_whose_component_sold_out(self, shop, db, auth, bundle_order):
        bundle, order = bundle_order
        db.get(Product, "PRD002").stock = 0
        db.flush()
        line = reorder_lines(shop, auth, order["id"])[0]
        assert line["status"] == "out_of_stock" and line["reason"] == "This bundle is sold out."

    def test_fewer_bundles_than_ordered_can_be_added(self, shop, db, auth, bundle_order):
        bundle, order = bundle_order
        db.get(Product, "PRD002").stock = 1
        db.flush()
        line = reorder_lines(shop, auth, order["id"])[0]
        assert line["status"] == "limited" and line["quantity"] == 1


class TestReorderEdges:
    def test_a_line_already_at_the_bag_limit_is_not_added(self, shop, db, auth):
        fill_bag(shop, auth, "PRD001", 1)
        order = place(shop, auth, method="cod")["order"]
        db.query(OrderItem).filter_by(order_id=order["id"]).one().quantity = 12
        db.get(Product, "PRD001").stock = 20
        db.flush()
        fill_bag(shop, auth, "PRD001", 10)
        line = reorder_lines(shop, auth, order["id"])[0]
        assert line["status"] == "in_bag" and line["inBag"] == 10

    def test_an_item_the_bag_refuses_is_reported_as_rejected(self, shop, db, auth, monkeypatch):
        from app.core.errors import ConflictError
        from app.services import cart

        fill_bag(shop, auth, "PRD001", 1)
        order = place(shop, auth, method="cod")["order"]

        def refuse(*args, **kwargs):
            raise ConflictError("Not today.", error_code="NOPE")

        monkeypatch.setattr(cart, "add_item", refuse)
        data = shop.post(f"/api/orders/{order['id']}/reorder", headers=auth, json={}).json()["data"]
        assert data["added"] == [] and data["skipped"][0]["status"] == "rejected"
        assert data["skipped"][0]["reason"] == "Not today."
        assert db.query(CartItem).count() == 0

    def test_a_draft_product_is_unavailable_not_discontinued(self, shop, db, auth):
        fill_bag(shop, auth, "PRD001", 1)
        order = place(shop, auth, method="cod")["order"]
        db.get(Product, "PRD001").status = "draft"
        db.flush()
        line = reorder_lines(shop, auth, order["id"])[0]
        assert line["status"] == "unavailable" and line["reason"] == "Not on sale right now"

    def test_the_figures_ignore_lines_that_were_not_added(self, shop, db, auth):
        from datetime import timedelta

        from app.services import reorder

        fill_bag(shop, auth, "PRD001", 1)
        fill_bag(shop, auth, "PRD002", 1)
        order = place(shop, auth, method="cod")["order"]
        db.get(Product, "PRD002").stock = 0
        db.flush()
        shop.post(f"/api/orders/{order['id']}/reorder", headers=auth, json={})
        now = datetime.utcnow()
        figures = reorder.metrics(db, start=now - timedelta(days=1), end=now + timedelta(days=1))
        assert figures["reorders"] == 1 and figures["itemsAdded"] == 1
        assert [p["productId"] for p in figures["topProducts"]] == ["PRD001"]
        empty = reorder.metrics(db, start=now + timedelta(days=5), end=now + timedelta(days=6))
        assert empty["reorders"] == 0 and empty["conversion"] is None
