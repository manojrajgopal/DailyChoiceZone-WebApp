"""
Shared test fixtures.

## Where the tests run

Against **MySQL**, in a database of their own (`daily_choice_zone_test` by
default, `TEST_DATABASE_NAME` to change it). Not SQLite: the application is
written against MySQL — `CAST(SUBSTR(...) AS UNSIGNED)` in the id generator,
`JSON` columns, `BigInteger` money — and a test suite that passes on a
different engine tells you the code works somewhere nobody runs it.

The test database is created if missing and its schema is built from the
models. The development database is never touched; `guard()` below refuses to
run if the two names ever coincide.

## Isolation

Each test runs inside a transaction that is rolled back afterwards, so tests
see the fixtures and nothing any other test wrote. The session the API uses is
the same one the test holds, which is what makes a rollback cover both.

## The fixture data

Deliberately small and written here rather than loaded from the demo seed. A
test that asserts on "the 47th product" is a test nobody can read, and a
fixture set that changes when the demo data is regenerated is a suite that
breaks for no reason.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core import database as db_module
from app.core.config import settings
from app.core.database import Base
from app.core.security import hash_password

TEST_DATABASE = os.environ.get("TEST_DATABASE_NAME", "daily_choice_zone_test")


def _guard() -> None:
    if TEST_DATABASE == settings.DATABASE_NAME:
        raise RuntimeError(
            f"The test database is '{TEST_DATABASE}', which is also the "
            "development database. Refusing to run — the tests drop tables."
        )


@pytest.fixture(scope="session")
def engine():
    """One engine for the run, against a database built from the models."""
    _guard()

    admin = create_engine(settings.server_url, pool_pre_ping=True)
    with admin.connect() as connection:
        connection.execute(
            text(f"CREATE DATABASE IF NOT EXISTS `{TEST_DATABASE}` "
                 "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
        )
        connection.commit()
    admin.dispose()

    url = f"{settings.server_url}/{TEST_DATABASE}?charset=utf8mb4"
    test_engine = create_engine(url, pool_pre_ping=True, future=True)

    with test_engine.begin() as connection:
        connection.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        Base.metadata.drop_all(bind=connection)
        Base.metadata.create_all(bind=connection)
        connection.execute(text("SET FOREIGN_KEY_CHECKS = 1"))

    yield test_engine
    test_engine.dispose()


@pytest.fixture()
def db(engine) -> Iterator[Session]:
    """
    A session inside a transaction that is rolled back at the end.

    The connection is held open for the test and the session is bound to it, so
    everything the test and the API do lands in the same transaction and
    disappears together.
    """
    connection = engine.connect()
    transaction = connection.begin()
    session = sessionmaker(bind=connection, autoflush=False, future=True)()

    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


@pytest.fixture()
def client(db) -> Iterator[TestClient]:
    """
    The API, talking to the test's own session.

    Built **without** entering the client as a context manager, which is what
    skips `lifespan`. That hook exists to create, migrate and seed the
    *development* database; running it here would reach past the test database
    entirely, and it is slow besides.

    `raise_server_exceptions=False` so an unhandled error arrives as the 500 a
    caller would actually receive, which is the thing worth asserting on.
    """
    from app.core.database import get_db
    from app.main import app

    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _no_real_database(monkeypatch, db):
    """
    Stop anything reaching the development database by accident.

    A service that built its own `SessionLocal()` instead of taking the request
    session would otherwise write to the real database and the rollback would
    not cover it. Pointing the factory at the test session makes that a visible
    failure rather than a silent one.
    """
    monkeypatch.setattr(db_module, "SessionLocal", lambda: db)


# ---------------------------------------------------------------- fixtures


PASSWORD = "Customer@123"
ADMIN_PASSWORD = "Admin@123"


@pytest.fixture()
def catalogue(db):
    """
    Two categories and four products, priced so the arithmetic is checkable.

    One of each state the storefront cares about: in stock, low stock, sold
    out, and a draft that must never be visible.
    """
    from app.models import Category, Product

    womens = Category(id="CAT001", slug="women", name="Women", display_order=1)
    electronics = Category(id="CAT002", slug="electronics", name="Electronics", display_order=2)
    db.add_all([womens, electronics])

    products = [
        Product(
            id="PRD001", slug="cotton-kurta", sku="DCZ-WO0001", name="Cotton Kurta",
            brand="Anvi", category_id="CAT001", subcategory="ethnic",
            price=1000.0, original_price=1250.0, discount=20, stock=10,
            status="active", rating=4.5, review_count=2,
        ),
        Product(
            id="PRD002", slug="linen-shirt", sku="DCZ-WO0002", name="Linen Shirt",
            brand="Anvi", category_id="CAT001", subcategory="tops",
            price=2000.0, original_price=2000.0, discount=0, stock=3,
            status="active", rating=4.0, review_count=1,
        ),
        Product(
            id="PRD003", slug="wireless-earbuds", sku="DCZ-EL0003", name="Wireless Earbuds",
            brand="Meridian", category_id="CAT002", subcategory="audio",
            price=3000.0, original_price=4000.0, discount=25, stock=0,
            status="out-of-stock", rating=4.2, review_count=5,
        ),
        Product(
            id="PRD004", slug="draft-jacket", sku="DCZ-WO0004", name="Draft Jacket",
            brand="Anvi", category_id="CAT001", subcategory="outerwear",
            price=5000.0, original_price=5000.0, discount=0, stock=5,
            status="draft", rating=0.0, review_count=0,
        ),
    ]
    db.add_all(products)
    db.flush()
    return products


@pytest.fixture()
def customer(db):
    from app.models import Address, Customer

    person = Customer(
        id="CUS001", email="shopper@example.com", password_hash=hash_password(PASSWORD),
        first_name="Asha", last_name="Rao", phone="9876500001",
        status="active", joined_at=datetime(2026, 1, 1),
    )
    db.add(person)
    db.add(Address(
        id="ADR001", customer_id="CUS001", full_name="Asha Rao", phone="9876500001",
        line1="4 Brigade Road", line2="", city="Bengaluru", state="Karnataka",
        pincode="560001", country="India", type="home", is_default=True,
    ))
    db.flush()
    return person


@pytest.fixture()
def other_customer(db):
    """Someone else, so "can I read their order?" has an answer to test."""
    from app.models import Customer

    person = Customer(
        id="CUS002", email="someone.else@example.com", password_hash=hash_password(PASSWORD),
        first_name="Ravi", last_name="Nair", phone="9876500002",
        status="active", joined_at=datetime(2026, 1, 1),
    )
    db.add(person)
    db.flush()
    return person


@pytest.fixture()
def admin(db):
    from app.models import AdminUser

    user = AdminUser(
        id="ADM001", email="admin@dailychoicezone.com",
        password_hash=hash_password(ADMIN_PASSWORD), name="Manoj Rajan",
        role="super-admin", permissions=[
            "products", "orders", "customers", "coupons", "reviews",
            "content", "reports", "settings", "admins",
        ],
        status="active", created_at=datetime(2026, 1, 1),
    )
    db.add(user)
    db.flush()
    return user


@pytest.fixture()
def editor(db):
    """A role that may touch content and nothing else — for the negative cases."""
    from app.models import AdminUser

    user = AdminUser(
        id="ADM002", email="editor@dailychoicezone.com",
        password_hash=hash_password(ADMIN_PASSWORD), name="Priya Sharma",
        role="editor", permissions=["products", "content"],
        status="active", created_at=datetime(2026, 1, 1),
    )
    db.add(user)
    db.flush()
    return user


@pytest.fixture()
def settings_documents(db):
    """The configuration the billing calculation reads."""
    from app.models import SettingDocument

    db.add_all([
        SettingDocument(key="tax", value={
            "enabled": True, "taxType": "GST", "pricesIncludeTax": True,
            "originState": "Karnataka", "gstin": "29AABCD1234E1Z5",
            "rates": {"cgst": 2.5, "sgst": 2.5, "igst": 5},
            "categoryRates": {"electronics": {"cgst": 9, "sgst": 9, "igst": 18}},
        }),
        SettingDocument(key="billing", value={
            "currency": {"code": "INR", "symbol": "₹", "locale": "en-IN", "decimals": 2},
            "invoice": {"prefix": "DCZ-INV", "startNumber": 1, "padding": 6, "dueDays": 7,
                        "notes": "", "paymentTerms": ""},
            "creditNote": {"prefix": "DCZ-CN", "startNumber": 1, "padding": 5},
            "refund": {"windowDays": 15, "refundShipping": False, "reasons": ["Item damaged"]},
            "payment": {"enabledMethods": ["upi", "card", "cod"], "codFee": 0},
        }),
        SettingDocument(key="store", value={
            "shipping": {"freeDeliveryThreshold": 999, "standardFee": 79, "expressFee": 149},
        }),
    ])
    db.flush()


@pytest.fixture()
def coupon(db):
    from app.models import Coupon

    code = Coupon(
        id="CPN001", code="SAVE10", description="10% off", type="percent", value=10,
        min_subtotal=500, max_discount=500, active=True,
        starts_at=datetime.utcnow() - timedelta(days=1),
        ends_at=datetime.utcnow() + timedelta(days=30),
        usage_limit=100, usage_count=0,
    )
    db.add(code)
    db.flush()
    return code


# ------------------------------------------------------------------ helpers


@pytest.fixture()
def token(client, customer) -> str:
    response = client.post("/api/auth/login",
                           json={"email": customer.email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]["accessToken"]


@pytest.fixture()
def auth(token) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def admin_token(client, admin) -> str:
    response = client.post("/api/admin/auth/login",
                           json={"email": admin.email, "password": ADMIN_PASSWORD})
    assert response.status_code == 200, response.text
    return response.json()["data"]["token"]["accessToken"]


@pytest.fixture()
def admin_auth(admin_token) -> dict:
    return {"Authorization": f"Bearer {admin_token}"}
