"""
What the database itself refuses, independent of any service.

Services check most of these rules first and answer with a friendly error. The
constraints are the last line: a race, a script, or a future bug that skips the
service still cannot write a duplicate, an orphan or a truncated value. These
tests go straight to the ORM, under the API, to prove the constraints exist.

Each refusal is attempted inside a savepoint, so the test's own transaction
survives it.
"""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DataError, IntegrityError, OperationalError

from app.core.security import hash_password
from app.models import (
    Address,
    CartItem,
    Category,
    Coupon,
    Customer,
    Order,
    OrderItem,
    Product,
    ProductImage,
    ProductTag,
    Review,
    WishlistItem,
)

pytestmark = pytest.mark.integration

_HASH = hash_password("Customer@123")


def _refused(db, *objects, error=IntegrityError):
    """Adding `objects` must fail; the savepoint keeps the test's transaction usable."""
    savepoint = db.begin_nested()
    with pytest.raises(error):
        db.add_all(objects)
        db.flush()
    savepoint.rollback()


def _person(id_="CUS100", email="person@example.com", **extra):
    values = dict(id=id_, email=email, password_hash=_HASH, first_name="P", last_name="", phone="",
                  status="active", joined_at=datetime(2026, 1, 1))
    values.update(extra)
    return Customer(**values)


def _product(id_="PRD100", slug="thing", sku="SKU-100", category="CAT001", **extra):
    values = dict(id=id_, slug=slug, sku=sku, name="Thing", brand="B", category_id=category, subcategory="s",
                  price=100.0, original_price=100.0, discount=0, stock=1, status="active")
    values.update(extra)
    return Product(**values)


def _order(db, customer_id="CUS001", order_id="ORD100", number="DCZ90100"):
    order = Order(
        id=order_id, order_number=number, customer_id=customer_id, customer_name="Asha", customer_email="a@b.co",
        placed_at=datetime(2026, 1, 1), status="confirmed", payment_status="paid", payment_method="upi",
        delivery_method="standard", expected_delivery="", item_count=1, subtotal=100, catalogue_savings=0,
        coupon_discount=0, delivery_fee=0, tax_amount=0, total=100, shipping_name="Asha", shipping_phone="1",
        shipping_line1="l", shipping_line2="", shipping_city="c", shipping_state="s", shipping_pincode="560001",
        shipping_country="India",
    )
    db.add(order)
    db.flush()
    return order


# ---------------------------------------------------------- the engine itself


class TestEngineSettings:
    def test_strict_mode_is_on(self, db):
        """Without STRICT_*, MySQL silently truncates an over-long value and stores a wrong one."""
        mode = db.execute(text("SELECT @@SESSION.sql_mode")).scalar()
        assert "STRICT_TRANS_TABLES" in mode or "STRICT_ALL_TABLES" in mode

    def test_an_over_long_value_is_refused_not_truncated(self, db):
        _refused(db, _person(email="x" * 300 + "@example.com"), error=(DataError, OperationalError))

    def test_four_byte_characters_survive(self, db, catalogue):
        """utf8mb4: emoji and the rupee sign round-trip intact (utf8mb3 would mangle the emoji)."""
        db.add(_product(name="Saree ₹ \U0001f9e3 साड़ी"))
        db.flush()
        db.expire_all()
        assert db.get(Product, "PRD100").name == "Saree ₹ \U0001f9e3 साड़ी"

    def test_the_database_is_utf8mb4(self, db):
        charset = db.execute(text("SELECT @@character_set_database")).scalar()
        assert charset == "utf8mb4"


# ------------------------------------------------------------------- unique


class TestUnique:
    def test_customer_email(self, db, customer):
        _refused(db, _person(email=customer.email))

    def test_customer_email_is_unique_regardless_of_case(self, db, customer):
        """The collation is case-insensitive, so SHOPPER@ and shopper@ are one account."""
        _refused(db, _person(email=customer.email.upper()))

    def test_product_slug_and_sku(self, db, catalogue):
        _refused(db, _product(slug="cotton-kurta"))
        _refused(db, _product(sku="DCZ-WO0001"))

    def test_category_slug(self, db, catalogue):
        _refused(db, Category(id="CAT100", slug="women", name="Women again"))

    def test_coupon_code(self, db, coupon):
        _refused(db, Coupon(id="CPN100", code="SAVE10", type="percent", value=5, starts_at=datetime(2026, 1, 1)))

    def test_order_number(self, db, customer):
        _order(db)
        savepoint = db.begin_nested()
        with pytest.raises(IntegrityError):
            _order(db, order_id="ORD101", number="DCZ90100")
        savepoint.rollback()

    def test_one_wishlist_row_per_product(self, db, customer, catalogue):
        db.add(WishlistItem(customer_id="CUS001", product_id="PRD001"))
        db.flush()
        _refused(db, WishlistItem(customer_id="CUS001", product_id="PRD001"))

    def test_a_cart_line_is_unique_per_variant(self, db, customer, catalogue):
        db.add(CartItem(customer_id="CUS001", product_id="PRD001", size="M", color="Red", quantity=1))
        db.flush()
        _refused(db, CartItem(customer_id="CUS001", product_id="PRD001", size="M", color="Red", quantity=2))

    def test_a_different_variant_is_a_different_line(self, db, customer, catalogue):
        db.add_all([CartItem(customer_id="CUS001", product_id="PRD001", size="M", color="Red", quantity=1),
                    CartItem(customer_id="CUS001", product_id="PRD001", size="L", color="Red", quantity=1)])
        db.flush()

    def test_a_tag_once_per_product(self, db, catalogue):
        db.add(ProductTag(product_id="PRD001", tag="cotton"))
        db.flush()
        _refused(db, ProductTag(product_id="PRD001", tag="cotton"))


# ---------------------------------------------------------------- not null


class TestRequired:
    @pytest.mark.parametrize("field", ["email", "password_hash", "first_name"])
    def test_a_customer_needs(self, db, field):
        _refused(db, _person(**{field: None}))

    @pytest.mark.parametrize("field", ["name", "sku", "slug", "price", "category_id"])
    def test_a_product_needs(self, db, catalogue, field):
        _refused(db, _product(**{field: None}))


# ------------------------------------------------------------ foreign keys


class TestReferences:
    def test_a_product_must_be_in_a_real_category(self, db, catalogue):
        _refused(db, _product(category="CAT999"))

    def test_a_cart_line_must_name_a_real_product(self, db, customer):
        _refused(db, CartItem(customer_id="CUS001", product_id="PRD999", quantity=1))

    def test_an_address_must_belong_to_a_real_customer(self, db):
        _refused(db, Address(id="ADR100", customer_id="CUS999", full_name="x", phone="", line1="l", line2="",
                             city="c", state="s", pincode="560001", country="India", type="home", is_default=False))

    def test_a_category_in_use_cannot_be_deleted(self, db, catalogue):
        """RESTRICT: the catalogue must stay reachable from the menu."""
        savepoint = db.begin_nested()
        with pytest.raises(IntegrityError):
            db.execute(text("DELETE FROM categories WHERE id = 'CAT001'"))
        savepoint.rollback()

    def test_a_product_that_was_sold_cannot_be_deleted(self, db, customer, catalogue):
        """RESTRICT: an order keeps pointing at what was bought."""
        order = _order(db)
        db.add(OrderItem(order_id=order.id, product_id="PRD001", name="Cotton Kurta", sku="DCZ-WO0001",
                         slug="cotton-kurta", brand="Anvi", image="", quantity=1, unit_price=100, line_total=100))
        db.flush()
        savepoint = db.begin_nested()
        with pytest.raises(IntegrityError):
            db.execute(text("DELETE FROM products WHERE id = 'PRD001'"))
        savepoint.rollback()

    def test_a_customer_with_orders_cannot_be_deleted(self, db, customer):
        _order(db)
        savepoint = db.begin_nested()
        with pytest.raises(IntegrityError):
            db.execute(text("DELETE FROM customers WHERE id = 'CUS001'"))
        savepoint.rollback()


class TestCascades:
    def test_deleting_a_customer_takes_their_address_cart_and_wishlist(self, db, customer, catalogue):
        db.add_all([CartItem(customer_id="CUS001", product_id="PRD001", quantity=1),
                    WishlistItem(customer_id="CUS001", product_id="PRD002")])
        db.flush()
        db.execute(text("DELETE FROM customers WHERE id = 'CUS001'"))
        for table in ("addresses", "cart_items", "wishlist_items"):
            count = db.execute(text(f"SELECT COUNT(*) FROM {table} WHERE customer_id = 'CUS001'")).scalar()
            assert count == 0, table

    def test_deleting_a_product_takes_its_images_tags_and_cart_lines(self, db, customer, catalogue):
        db.add_all([ProductImage(product_id="PRD002", url="https://cdn.example/a.jpg", position=0),
                    ProductTag(product_id="PRD002", tag="linen"),
                    CartItem(customer_id="CUS001", product_id="PRD002", quantity=1)])
        db.flush()
        db.execute(text("DELETE FROM products WHERE id = 'PRD002'"))
        for table in ("product_images", "product_tags", "cart_items"):
            assert db.execute(text(f"SELECT COUNT(*) FROM {table} WHERE product_id = 'PRD002'")).scalar() == 0

    def test_deleting_a_customer_keeps_their_reviews_anonymously(self, db, catalogue):
        """SET NULL: the review stays on the product page; who wrote it is forgotten."""
        db.add(_person())
        db.flush()
        db.add(Review(id="REV100", product_id="PRD001", customer_id="CUS100", author="P", rating=5, title="Nice",
                      body="Really very nice.", status="approved", verified_purchase=False,
                      submitted_at=datetime(2026, 1, 1)))
        db.flush()
        db.execute(text("DELETE FROM customers WHERE id = 'CUS100'"))
        db.expire_all()
        review = db.get(Review, "REV100")
        assert review is not None and review.customer_id is None


# ----------------------------------------------------------------- defaults


class TestDefaults:
    def test_a_new_customer(self, db):
        db.add(Customer(id="CUS101", email="new@example.com", password_hash=_HASH, first_name="N"))
        db.flush()
        db.expire_all()
        person = db.get(Customer, "CUS101")
        assert person.status == "active" and person.last_name == "" and person.phone == ""
        assert person.joined_at is not None and person.email_verified_at is None
        assert person.created_at is not None and person.updated_at is not None

    def test_a_new_coupon(self, db):
        db.add(Coupon(id="CPN101", code="NEW", starts_at=datetime(2026, 1, 1)))
        db.flush()
        db.expire_all()
        new = db.get(Coupon, "CPN101")
        assert new.type == "percent" and new.active is True and new.usage_count == 0

    def test_updated_at_moves_on_an_update(self, db, customer):
        before = customer.updated_at
        db.execute(text("UPDATE customers SET updated_at = '2020-01-01 00:00:00' WHERE id = 'CUS001'"))
        db.expire_all()
        person = db.get(Customer, "CUS001")
        person.first_name = "Renamed"
        db.flush()
        db.expire_all()
        assert db.get(Customer, "CUS001").updated_at > datetime(2020, 1, 1)
        assert before is not None
