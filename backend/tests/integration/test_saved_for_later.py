"""
Saved for later: moving bag lines aside and back, with every check the bag
makes on the way back in — and the price, stock and variant as they are now,
never as they were when the line was saved.
"""

from __future__ import annotations

import pytest

from app.core.config import settings

pytestmark = pytest.mark.integration


def add(client, auth, product_id="PRD001", **extra):
    response = client.post("/api/cart/items", headers=auth, json={"productId": product_id, **extra})
    assert response.status_code == 201, response.text
    return response.json()["data"]


def line_id(cart, product_id):
    return next(i["id"] for i in cart["items"] if i["productId"] == product_id)


def save(client, auth, item_id):
    return client.post(f"/api/cart/items/{item_id}/save-for-later", headers=auth)


def saved(client, auth):
    response = client.get("/api/cart/saved", headers=auth)
    assert response.status_code == 200, response.text
    return response.json()["data"]["items"]


def move(client, auth, saved_id, **body):
    return client.post(f"/api/cart/saved/{saved_id}/move-to-cart", headers=auth, json=body or None)


class TestSaving:
    def test_a_bag_line_moves_to_saved(self, client, auth, catalogue, settings_documents):
        cart = add(client, auth, "PRD001", quantity=2)
        add(client, auth, "PRD002")
        response = save(client, auth, line_id(cart, "PRD001"))
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert [i["productId"] for i in data["cart"]["items"]] == ["PRD002"]
        assert [(i["productId"], i["quantity"]) for i in data["saved"]["items"]] == [("PRD001", 2)]
        item = data["saved"]["items"][0]
        assert item["unitPrice"] == 100000 and item["savedUnitPrice"] == 100000
        assert item["status"] == "available" and item["canMoveToCart"] is True

    def test_saving_the_same_variant_again_merges(self, client, db, auth, customer, catalogue, settings_documents):
        from app.models import SavedCartItem

        cart = add(client, auth, "PRD001", quantity=2)
        save(client, auth, line_id(cart, "PRD001"))
        cart = add(client, auth, "PRD001", quantity=3)
        save(client, auth, line_id(cart, "PRD001"))
        rows = db.query(SavedCartItem).filter_by(customer_id=customer.id).all()
        assert len(rows) == 1 and rows[0].quantity == 5

    def test_saving_twice_moves_once(self, client, auth, catalogue, settings_documents):
        cart = add(client, auth, "PRD001")
        item = line_id(cart, "PRD001")
        assert save(client, auth, item).status_code == 200
        second = save(client, auth, item)
        assert second.status_code == 404
        assert second.json()["error_code"] == "CART_ITEM_NOT_FOUND"
        assert len(saved(client, auth)) == 1

    def test_wishlist_and_saved_are_separate(self, client, auth, catalogue, settings_documents):
        client.post("/api/wishlist/PRD001", headers=auth)
        cart = add(client, auth, "PRD001")
        save(client, auth, line_id(cart, "PRD001"))
        item = saved(client, auth)[0]
        assert item["inWishlist"] is True
        # Both kept: removing one does not touch the other.
        client.delete(f"/api/cart/saved/{item['id']}", headers=auth)
        assert client.get("/api/wishlist/ids", headers=auth).json()["data"] == ["PRD001"]

    def test_the_limit(self, client, db, auth, customer, catalogue, settings_documents, monkeypatch):
        monkeypatch.setattr(settings, "SAVED_FOR_LATER_LIMIT", 1)
        cart = add(client, auth, "PRD001")
        add(client, auth, "PRD002")
        save(client, auth, line_id(cart, "PRD001"))
        cart = client.get("/api/cart", headers=auth).json()["data"]
        response = save(client, auth, line_id(cart, "PRD002"))
        assert response.status_code == 409
        assert response.json()["error_code"] == "SAVED_LIMIT_REACHED"
        # Refused means nothing moved: the line is still in the bag.
        assert [i["productId"] for i in client.get("/api/cart", headers=auth).json()["data"]["items"]] == ["PRD002"]


class TestMovingBack:
    def test_back_to_the_bag(self, client, db, auth, catalogue, settings_documents):
        from app.models import AnalyticsEvent

        cart = add(client, auth, "PRD001", quantity=2)
        save(client, auth, line_id(cart, "PRD001"))
        item = saved(client, auth)[0]
        response = move(client, auth, item["id"])
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["moved"] == 2
        assert [(i["productId"], i["quantity"]) for i in data["cart"]["items"]] == [("PRD001", 2)]
        assert data["saved"]["items"] == []
        assert db.query(AnalyticsEvent).filter_by(event="saved_moved_to_cart").count() == 1

    def test_the_price_charged_is_todays(self, client, db, auth, catalogue, settings_documents):
        from app.models import Product

        cart = add(client, auth, "PRD001")
        save(client, auth, line_id(cart, "PRD001"))
        db.get(Product, "PRD001").price = 800
        db.flush()
        item = saved(client, auth)[0]
        assert item["unitPrice"] == 80000
        assert item["priceDrop"] == {"from": 100000, "to": 80000}
        data = move(client, auth, item["id"]).json()["data"]
        assert data["cart"]["items"][0]["unitPrice"] == 80000

    def test_a_price_rise_is_not_called_a_drop(self, client, db, auth, catalogue, settings_documents):
        from app.models import Product

        cart = add(client, auth, "PRD001")
        save(client, auth, line_id(cart, "PRD001"))
        db.get(Product, "PRD001").price = 1200
        db.flush()
        item = saved(client, auth)[0]
        assert item["priceDrop"] is None and item["priceRise"] is True

    def test_out_of_stock_stays_saved(self, client, db, auth, catalogue, settings_documents):
        from app.models import Product

        cart = add(client, auth, "PRD001")
        save(client, auth, line_id(cart, "PRD001"))
        product = db.get(Product, "PRD001")
        product.stock, product.status = 0, "out-of-stock"
        db.flush()
        item = saved(client, auth)[0]
        assert item["status"] == "out-of-stock" and item["message"] == "Currently unavailable"
        assert item["canMoveToCart"] is False
        response = move(client, auth, item["id"])
        assert response.status_code == 409
        assert response.json()["error_code"] == "OUT_OF_STOCK"
        assert len(saved(client, auth)) == 1
        assert client.get("/api/cart", headers=auth).json()["data"]["items"] == []

    def test_fewer_in_stock_moves_what_there_is(self, client, db, auth, catalogue, settings_documents):
        from app.models import Product

        cart = add(client, auth, "PRD001", quantity=5)
        save(client, auth, line_id(cart, "PRD001"))
        db.get(Product, "PRD001").stock = 2
        db.flush()
        item = saved(client, auth)[0]
        assert item["status"] == "limited" and item["maxQuantity"] == 2
        response = move(client, auth, item["id"])
        assert response.status_code == 200
        assert response.json()["data"]["moved"] == 2
        assert "Only 2" in response.json()["message"]

    @pytest.mark.parametrize("status", ["draft", "archived"])
    def test_a_withdrawn_product_cannot_go_back(self, client, db, auth, catalogue, settings_documents, status):
        from app.models import Product

        cart = add(client, auth, "PRD002")
        save(client, auth, line_id(cart, "PRD002"))
        db.get(Product, "PRD002").status = status
        db.flush()
        item = saved(client, auth)[0]
        assert item["status"] == "unavailable" and item["canMoveToCart"] is False
        response = move(client, auth, item["id"])
        assert response.status_code == 404
        assert len(saved(client, auth)) == 1

    def test_a_deleted_product_disappears(self, client, db, auth, customer, catalogue, settings_documents):
        from app.models import Product, SavedCartItem

        cart = add(client, auth, "PRD002")
        save(client, auth, line_id(cart, "PRD002"))
        db.delete(db.get(Product, "PRD002"))
        db.flush()
        assert db.query(SavedCartItem).filter_by(customer_id=customer.id).count() == 0
        assert saved(client, auth) == []

    def test_a_size_that_no_longer_exists(self, client, db, auth, catalogue, settings_documents):
        from app.models import ProductSize

        db.add_all([ProductSize(product_id="PRD001", label="M", position=0),
                    ProductSize(product_id="PRD001", label="L", position=1)])
        db.flush()
        cart = add(client, auth, "PRD001", size="M")
        save(client, auth, line_id(cart, "PRD001"))
        db.query(ProductSize).filter_by(product_id="PRD001", label="M").delete()
        db.flush()
        db.expire_all()
        item = saved(client, auth)[0]
        assert item["status"] == "variant-unavailable"
        response = move(client, auth, item["id"])
        assert response.status_code == 422
        assert response.json()["error_code"] == "SIZE_UNAVAILABLE"
        assert len(saved(client, auth)) == 1

    def test_the_line_limit_holds(self, client, auth, catalogue, settings_documents):
        cart = add(client, auth, "PRD001", quantity=6)
        save(client, auth, line_id(cart, "PRD001"))
        add(client, auth, "PRD001", quantity=8)
        item = saved(client, auth)[0]
        response = move(client, auth, item["id"])
        assert response.status_code == 200
        lines = response.json()["data"]["cart"]["items"]
        assert lines[0]["quantity"] == 10  # MAX_QUANTITY_PER_LINE, not 14

    def test_a_flash_sale_limit_is_respected(self, client, db, auth, catalogue, settings_documents, monkeypatch):
        from app.core.errors import ValidationError
        from app.services import cart as cart_service

        cart = add(client, auth, "PRD001", quantity=2)
        save(client, auth, line_id(cart, "PRD001"))

        def refuse(*_args, **_kwargs):
            raise ValidationError("The sale allows 1 per customer.", error_code="FLASH_SALE_LIMIT")

        monkeypatch.setattr(cart_service, "_refuse_over_flash_limit", refuse)
        item = saved(client, auth)[0]
        response = move(client, auth, item["id"])
        assert response.status_code == 422
        assert response.json()["error_code"] == "FLASH_SALE_LIMIT"
        assert len(saved(client, auth)) == 1

    @pytest.mark.parametrize("quantity", [0, 11, -1])
    def test_an_invalid_quantity_is_refused(self, client, auth, catalogue, settings_documents, quantity):
        cart = add(client, auth, "PRD001")
        save(client, auth, line_id(cart, "PRD001"))
        item = saved(client, auth)[0]
        assert move(client, auth, item["id"], quantity=quantity).status_code == 422
        assert client.put(f"/api/cart/saved/{item['id']}", headers=auth,
                          json={"quantity": quantity}).status_code == 422

    def test_change_the_saved_quantity(self, client, auth, catalogue, settings_documents):
        cart = add(client, auth, "PRD001")
        save(client, auth, line_id(cart, "PRD001"))
        item = saved(client, auth)[0]
        response = client.put(f"/api/cart/saved/{item['id']}", headers=auth, json={"quantity": 3})
        assert response.json()["data"]["items"][0]["quantity"] == 3


class TestRemoving:
    def test_remove_one_and_clear(self, client, auth, catalogue, settings_documents):
        cart = add(client, auth, "PRD001")
        add(client, auth, "PRD002")
        save(client, auth, line_id(cart, "PRD001"))
        cart = client.get("/api/cart", headers=auth).json()["data"]
        save(client, auth, line_id(cart, "PRD002"))
        items = saved(client, auth)
        assert client.delete(f"/api/cart/saved/{items[0]['id']}", headers=auth).status_code == 200
        assert len(saved(client, auth)) == 1
        assert client.delete("/api/cart/saved", headers=auth).status_code == 200
        assert saved(client, auth) == []

    def test_removing_what_is_not_there(self, client, auth, catalogue):
        assert client.delete("/api/cart/saved/999999", headers=auth).status_code == 404


class TestOwnership:
    @pytest.fixture()
    def theirs(self, db, other_customer, catalogue):
        from app.models import SavedCartItem

        row = SavedCartItem(customer_id=other_customer.id, product_id="PRD001", size="", color="", quantity=1,
                            saved_unit_price=100000)
        db.add(row)
        db.flush()
        return row

    def test_another_customers_line_is_invisible(self, client, auth, theirs):
        assert saved(client, auth) == []

    @pytest.mark.parametrize("call", ["move", "update", "delete"])
    def test_another_customers_line_cannot_be_touched(self, client, db, auth, theirs, call):
        from app.models import SavedCartItem

        if call == "move":
            response = move(client, auth, theirs.id)
        elif call == "update":
            response = client.put(f"/api/cart/saved/{theirs.id}", headers=auth, json={"quantity": 2})
        else:
            response = client.delete(f"/api/cart/saved/{theirs.id}", headers=auth)
        assert response.status_code == 404
        db.expire_all()
        row = db.get(SavedCartItem, theirs.id)
        assert row is not None and row.quantity == 1

    def test_another_customers_bag_line_cannot_be_saved(self, client, db, auth, other_customer, catalogue):
        from app.models import CartItem

        line = CartItem(customer_id=other_customer.id, product_id="PRD001", size="", color="", quantity=1)
        db.add(line)
        db.flush()
        assert save(client, auth, line.id).status_code == 404
        assert db.get(CartItem, line.id) is not None

    def test_clearing_only_clears_your_own(self, client, db, auth, theirs):
        from app.models import SavedCartItem

        client.delete("/api/cart/saved", headers=auth)
        assert db.get(SavedCartItem, theirs.id) is not None

    def test_signed_out_is_refused(self, client):
        assert client.get("/api/cart/saved").status_code == 401
        assert client.post("/api/cart/saved/merge", json={"items": []}).status_code == 401


class TestGuestMerge:
    def test_a_guests_saved_lines_join_the_account(self, client, db, auth, catalogue, settings_documents):
        from app.models import ProductSize

        db.add(ProductSize(product_id="PRD002", label="M", position=0))
        db.flush()
        response = client.post("/api/cart/saved/merge", headers=auth, json={"items": [
            {"productId": "PRD001", "quantity": 2},
            {"productId": "PRD002", "size": "M"},
            {"productId": "PRD002", "size": "XXL"},     # not a size it comes in
            {"productId": "PRD004"},                    # a draft
            {"productId": "PRD999"},                    # nothing
        ]})
        assert response.status_code == 200, response.text
        data = response.json()["data"]
        assert data["merged"] == 2 and data["skipped"] == 3
        assert sorted((i["productId"], i["quantity"]) for i in data["items"]) == [("PRD001", 2), ("PRD002", 1)]

    def test_duplicates_merge_with_whats_saved(self, client, auth, catalogue, settings_documents):
        cart = add(client, auth, "PRD001", quantity=2)
        save(client, auth, line_id(cart, "PRD001"))
        client.post("/api/cart/saved/merge", headers=auth, json={"items": [{"productId": "PRD001", "quantity": 3}]})
        items = saved(client, auth)
        assert len(items) == 1 and items[0]["quantity"] == 5

    def test_an_out_of_stock_guest_line_is_kept(self, client, auth, catalogue, settings_documents):
        data = client.post("/api/cart/saved/merge", headers=auth,
                           json={"items": [{"productId": "PRD003"}]}).json()["data"]
        assert data["merged"] == 1
        assert data["items"][0]["status"] == "out-of-stock"


class TestConcurrency:
    def test_two_moves_of_one_line_add_it_once(self, client, db, auth, customer, catalogue, settings_documents):
        """The second request finds the line gone rather than adding it twice."""
        cart = add(client, auth, "PRD001", quantity=2)
        save(client, auth, line_id(cart, "PRD001"))
        item = saved(client, auth)[0]
        assert move(client, auth, item["id"]).status_code == 200
        again = move(client, auth, item["id"])
        assert again.status_code == 404
        assert client.get("/api/cart", headers=auth).json()["data"]["items"][0]["quantity"] == 2

    def test_a_concurrent_insert_is_a_conflict_not_a_500(self, db, customer, catalogue, monkeypatch):
        from sqlalchemy.exc import IntegrityError

        from app.core.errors import ConflictError
        from app.models import CartItem
        from app.services import saved_for_later

        line = CartItem(customer_id=customer.id, product_id="PRD001", size="", color="", quantity=1)
        db.add(line)
        db.commit()

        def clash(*_args, **_kwargs):
            raise IntegrityError("INSERT", {}, Exception("Duplicate entry"))

        monkeypatch.setattr(saved_for_later, "_put", clash)
        with pytest.raises(ConflictError):
            saved_for_later.save_from_cart(db, customer, line.id)
        assert db.get(CartItem, line.id) is not None
