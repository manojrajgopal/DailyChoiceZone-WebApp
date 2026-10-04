"""
The people lists find a customer by Customer ID only (docs/id-lookup.md).

Customers, abandoned carts and the points ledger take an ID, exactly: the
customer's own, or (on the ledger) an Order ID. A name, an email, a phone
number or the start of an ID keeps nothing.
"""

from __future__ import annotations

from datetime import datetime

from app.models import CartRecovery, LoyaltyAccount, LoyaltyTransaction, Order


def _ids(response) -> list:
    assert response.status_code == 200, response.text
    return [row["id"] for row in response.json()["data"]]


class TestCustomerList:
    def test_a_customer_id_keeps_exactly_that_customer(self, client, customer, other_customer, admin_auth):
        assert _ids(client.get("/api/admin/customers", headers=admin_auth)) == ["CUS001", "CUS002"]
        assert _ids(client.get("/api/admin/customers", headers=admin_auth, params={"q": "CUS002"})) == ["CUS002"]
        assert _ids(client.get("/api/admin/customers", headers=admin_auth, params={"q": " cus001 "})) == ["CUS001"]

    def test_names_emails_phones_and_partial_ids_match_nothing(self, client, customer, other_customer, admin_auth):
        for text in ("Asha", "Asha Rao", "shopper@example.com", "9876500001", "CUS00", "CUS0011"):
            assert _ids(client.get("/api/admin/customers", headers=admin_auth, params={"q": text})) == [], text

    def test_a_blank_filter_is_no_filter(self, client, customer, other_customer, admin_auth):
        assert len(_ids(client.get("/api/admin/customers", headers=admin_auth, params={"q": "  "}))) == 2


class TestAbandonedCarts:
    def _cart(self, db, customer_id):
        now = datetime.utcnow()
        db.add(CartRecovery(customer_id=customer_id, status="abandoned", started_at=now, last_activity_at=now,
                            abandoned_at=now, item_count=1, cart_value=100000, reminders_sent=0,
                            created_at=now, updated_at=now))
        db.flush()

    def _customers(self, client, admin_auth, q):
        response = client.get("/api/admin/carts/abandoned", headers=admin_auth, params={"q": q})
        assert response.status_code == 200, response.text
        return [item["customer"]["id"] for item in response.json()["data"]["items"]]

    def test_only_a_customer_id_finds_their_cart(self, client, db, customer, other_customer, admin_auth):
        self._cart(db, "CUS001")
        self._cart(db, "CUS002")
        assert self._customers(client, admin_auth, "CUS002") == ["CUS002"]
        assert sorted(self._customers(client, admin_auth, "")) == ["CUS001", "CUS002"]
        for text in ("Ravi", "someone.else@example.com", "CUS00"):
            assert self._customers(client, admin_auth, text) == [], text


class TestPointsLedger:
    def test_an_order_id_or_customer_id_finds_its_movements(self, client, db, customer, other_customer, admin_auth):
        now = datetime.utcnow()
        db.add(Order(id="ORD951", order_number="DCZ95001", customer_id="CUS001", customer_name="Asha Rao",
                     customer_email="shopper@example.com", placed_at=now, status="confirmed",
                     payment_status="paid", payment_method="upi", total=500, subtotal=500, item_count=1))
        db.add(LoyaltyAccount(customer_id="CUS001", created_at=now, updated_at=now))
        db.flush()
        db.add_all([
            LoyaltyTransaction(customer_id="CUS001", kind="earn", points=50, balance_after=50, order_id="ORD951",
                               reason="Points for order DCZ95001", created_at=now),
            LoyaltyTransaction(customer_id="CUS001", kind="manual_credit", points=10, balance_after=60,
                               reason="Goodwill", created_at=now),
        ])
        db.flush()

        def kinds(**params):
            response = client.get("/api/admin/loyalty/ledger", headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return sorted(item["kind"] for item in response.json()["data"]["items"])

        assert kinds(q="DCZ95001") == ["earn"]
        assert kinds(q="CUS001") == ["earn", "manual_credit"]
        assert kinds(q="CUS002") == []
        for text in ("Asha", "Goodwill", "Points for order", "DCZ9500"):
            assert kinds(q=text) == [], text

    def test_the_ledger_takes_separate_customer_and_order_ids(self, client, db, customer, other_customer,
                                                                admin_auth):
        now = datetime.utcnow()
        db.add(Order(id="ORD952", order_number="DCZ95002", customer_id="CUS001", customer_name="Asha Rao",
                     customer_email="shopper@example.com", placed_at=now, status="confirmed",
                     payment_status="paid", payment_method="upi", total=500, subtotal=500, item_count=1))
        db.add(LoyaltyAccount(customer_id="CUS001", created_at=now, updated_at=now))
        db.flush()
        db.add_all([
            LoyaltyTransaction(customer_id="CUS001", kind="earn", points=50, balance_after=50, order_id="ORD952",
                               reason="Points for order DCZ95002", created_at=now),
            LoyaltyTransaction(customer_id="CUS001", kind="manual_credit", points=10, balance_after=60,
                               reason="Goodwill", created_at=now),
        ])
        db.flush()

        def kinds(**params):
            response = client.get("/api/admin/loyalty/ledger", headers=admin_auth, params=params)
            assert response.status_code == 200, response.text
            return sorted(item["kind"] for item in response.json()["data"]["items"])

        assert kinds(orderId="DCZ95002") == ["earn"]
        assert kinds(orderId="ORD952") == ["earn"]
        assert kinds(customerId="cus001") == ["earn", "manual_credit"]
        assert kinds(customerId="CUS001", orderId="DCZ95002") == ["earn"]
        assert kinds(customerId="CUS002", orderId="DCZ95002") == []
        for text in ("DCZ950021", "ORD9520", "Asha", "shopper@example.com", "'; DROP TABLE orders; --"):
            assert kinds(orderId=text) == [] and kinds(customerId=text) == [] and kinds(q=text) == [], text


class TestJunkAndPermissions:
    LISTS = ("/api/admin/customers", "/api/admin/carts/abandoned", "/api/admin/loyalty/balances",
             "/api/admin/loyalty/ledger", "/api/admin/store-credit", "/api/admin/memberships/search",
             "/api/admin/questions")

    def test_junk_and_longer_ids_match_nothing_without_an_error(self, client, db, customer, other_customer,
                                                                 admin_auth):
        now = datetime.utcnow()
        db.add(LoyaltyAccount(customer_id="CUS001", created_at=now, updated_at=now))
        db.flush()
        for path in self.LISTS:
            for text in ("'; DROP TABLE customers; --", "CUS0011", "%", "Asha"):
                response = client.get(path, headers=admin_auth, params={"q": text})
                assert response.status_code == 200, (path, text, response.text)
                data = response.json()["data"]
                rows = data if isinstance(data, list) else data["items"]
                assert rows == [], (path, text)

    def test_permissions_are_unchanged(self, client, db, customer, admin_auth):
        from app.core.security import hash_password
        from app.models import AdminUser

        db.add(AdminUser(id="ADM051", email="packer@example.com", password_hash=hash_password("Admin@123"),
                         name="Packer", role="packer-only", permissions=["packing"], status="active",
                         created_at=datetime(2026, 1, 1)))
        db.flush()
        login = client.post("/api/admin/auth/login", json={"email": "packer@example.com", "password": "Admin@123"})
        assert login.status_code == 200, login.text
        packer = {"Authorization": f"Bearer {login.json()['data']['token']['accessToken']}"}
        for path in self.LISTS:
            assert client.get(path, headers=packer, params={"q": "CUS001"}).status_code == 403, path
            assert client.get(path, params={"q": "CUS001"}).status_code == 401, path
