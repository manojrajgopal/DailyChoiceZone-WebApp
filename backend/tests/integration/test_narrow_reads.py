"""
The endpoints and filters that exist so a page can stop over-reading.

Every case here has the same shape: a screen needed a number, or one row, or
eight rows, and used to get there by downloading a whole table and doing the
work in the browser. What is being tested is that the narrow read returns
*exactly* what the wide one plus that browser-side work returned — because a
cheaper answer that is a different answer is not an optimisation.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


ADDRESS = {
    "fullName": "Asha Rao", "phone": "9876500001", "line1": "4 Brigade Road",
    "line2": "", "city": "Bengaluru", "state": "Karnataka", "pincode": "560001",
    "country": "India", "email": "shopper@example.com",
}


@pytest.fixture()
def order(client, auth, catalogue, settings_documents):
    """A paid order, with the invoice and payment it produced."""
    client.post("/api/cart/items", headers=auth,
                json={"productId": "PRD001", "quantity": 2})

    response = client.post("/api/orders", headers=auth, json={
        "shippingAddress": ADDRESS, "billingAddress": None,
        "deliveryMethod": "standard", "paymentMethod": "upi",
        "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
    })
    assert response.status_code == 201, response.text

    # The response nests the order beside the documents it produced; every
    # test here wants the order's own id to hand.
    payload = response.json()["data"]
    return {**payload, "id": payload["order"]["id"]}


class TestCartCount:
    """
    The header badge's endpoint.

    It exists because the badge asked for the priced cart: every product in it
    serialised, and the delivery, coupon and tax arithmetic run, to render one
    integer.
    """

    def test_it_needs_an_account(self, client):
        assert client.get("/api/cart/count").status_code == 401

    def test_an_admin_token_is_not_a_customer_token(self, client, admin_auth):
        assert client.get("/api/cart/count", headers=admin_auth).status_code == 403

    def test_an_empty_bag_counts_zero(self, client, auth):
        response = client.get("/api/cart/count", headers=auth)
        assert response.status_code == 200
        assert response.json()["data"]["itemCount"] == 0

    def test_it_sums_quantities_not_lines(self, client, auth, catalogue, settings_documents):
        """
        Two of one thing and three of another is five items, not two lines.

        The badge shows items, so summing the rows would have shown 2.
        """
        client.post("/api/cart/items", headers=auth,
                    json={"productId": "PRD001", "quantity": 2})
        client.post("/api/cart/items", headers=auth,
                    json={"productId": "PRD002", "quantity": 3})

        assert client.get("/api/cart/count", headers=auth).json()["data"]["itemCount"] == 5

    def test_it_agrees_with_the_priced_cart(self, client, auth, catalogue, settings_documents):
        """The whole point: the cheap answer is the same answer."""
        client.post("/api/cart/items", headers=auth,
                    json={"productId": "PRD001", "quantity": 2, "size": "M"})
        client.post("/api/cart/items", headers=auth,
                    json={"productId": "PRD001", "quantity": 1, "size": "L"})

        cheap = client.get("/api/cart/count", headers=auth).json()["data"]["itemCount"]
        priced = client.get("/api/cart", headers=auth).json()["data"]["breakdown"]["itemCount"]
        assert cheap == priced

    def test_one_customer_does_not_see_another_s_count(
        self, client, auth, catalogue, settings_documents, db, other_customer
    ):
        client.post("/api/cart/items", headers=auth,
                    json={"productId": "PRD001", "quantity": 4})

        response = client.post("/api/auth/login", json={
            "email": other_customer.email, "password": "Customer@123",
        })
        other = {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}

        assert client.get("/api/cart/count", headers=other).json()["data"]["itemCount"] == 0


class TestNavCounts:
    """
    The three numbers beside the sidebar links.

    They used to be counted in the browser from the inventory, the orders and
    the reviews in full — around 459 KB on every page view of the portal, to
    render three integers.
    """

    def test_it_needs_an_administrator(self, client):
        assert client.get("/api/admin/nav-counts").status_code == 401

    def test_a_customer_token_is_not_an_admin_token(self, client, auth):
        assert client.get("/api/admin/nav-counts", headers=auth).status_code == 403

    def test_an_empty_shop_is_all_zeroes(self, client, admin_auth):
        counts = client.get("/api/admin/nav-counts", headers=admin_auth).json()["data"]
        assert counts == {"lowStock": 0, "openOrders": 0, "pendingReviews": 0, "openReturns": 0,
                          "openTickets": 0, "pendingQuestions": 0}

    def test_low_stock_is_in_stock_but_at_or_below_the_threshold(
        self, client, admin_auth, catalogue, db
    ):
        """
        Sold out is not low stock — it is a different badge and a different job.

        Thresholds are set explicitly here rather than left at the model's
        default, so the figure is a property of the test and not of that
        default: PRD002 is under its threshold, PRD001 and PRD004 are over, and
        PRD003 has none at all and must stay out of the count.
        """
        from app.models import Product

        db.get(Product, "PRD001").low_stock_threshold = 2   # 10 in stock, fine
        db.get(Product, "PRD002").low_stock_threshold = 3   # 3 in stock, low
        db.get(Product, "PRD003").low_stock_threshold = 5   # none, not "low"
        db.get(Product, "PRD004").low_stock_threshold = 1   # 5 in stock, fine
        db.flush()

        counts = client.get("/api/admin/nav-counts", headers=admin_auth).json()["data"]
        assert counts["lowStock"] == 1

    def test_open_orders_excludes_the_finished_ones(self, client, admin_auth, order, db):
        from app.models import Order

        assert client.get("/api/admin/nav-counts",
                          headers=admin_auth).json()["data"]["openOrders"] == 1

        db.get(Order, order["id"]).status = "delivered"
        db.flush()

        assert client.get("/api/admin/nav-counts",
                          headers=admin_auth).json()["data"]["openOrders"] == 0


class TestBillingOverview:
    """
    The billing landing page's three panels.

    It used to assemble them from every invoice, every payment and every refund
    in the business — some 470 KB — to show eight rows, the refunds still open,
    and a total per payment method.
    """

    def test_it_needs_an_administrator(self, client):
        assert client.get("/api/admin/billing/overview").status_code == 401

    def test_it_reports_the_order_s_invoice_and_payment(self, client, admin_auth, order):
        overview = client.get("/api/admin/billing/overview",
                              headers=admin_auth).json()["data"]

        assert [i["id"] for i in overview["recentInvoices"]] == [order["invoiceId"]]
        assert overview["paymentsByMethod"] == [{"method": "upi", "amount": 200000}]

    def test_it_stops_at_eight_invoices(self, client, auth, admin_auth, catalogue,
                                        settings_documents):
        """The panel is titled "the eight most recent", so nine must return eight."""
        for _ in range(9):
            client.post("/api/cart/items", headers=auth,
                        json={"productId": "PRD001", "quantity": 1})
            client.post("/api/orders", headers=auth, json={
                "shippingAddress": ADDRESS, "billingAddress": None,
                "deliveryMethod": "standard", "paymentMethod": "upi",
                "couponCode": None, "email": "shopper@example.com", "saveAddress": False,
            })

        overview = client.get("/api/admin/billing/overview",
                              headers=admin_auth).json()["data"]
        assert len(overview["recentInvoices"]) == 8

    def test_open_refunds_excludes_the_settled_ones(self, client, admin_auth, order, db):
        created = client.post("/api/admin/billing/refunds", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "amount": 50000, "reason": "damaged",
            "status": "requested",
        })
        assert created.status_code == 201, created.text
        refund_id = created.json()["data"]["id"]

        overview = client.get("/api/admin/billing/overview",
                              headers=admin_auth).json()["data"]
        assert [r["id"] for r in overview["openRefunds"]] == [refund_id]

        from app.models import Refund

        db.get(Refund, refund_id).status = "completed"
        db.flush()

        overview = client.get("/api/admin/billing/overview",
                              headers=admin_auth).json()["data"]
        assert overview["openRefunds"] == []

    def test_a_failed_payment_is_not_money_taken(self, client, admin_auth, order, db):
        from app.models import Payment

        db.get(Payment, order["paymentId"]).status = "failed"
        db.flush()

        overview = client.get("/api/admin/billing/overview",
                              headers=admin_auth).json()["data"]
        assert overview["paymentsByMethod"] == []


class TestNarrowingFilters:
    """
    The filters the detail screens use.

    Each replaced a whole-table read followed by a `.find()` in the browser, so
    each test compares the narrowed answer with the unnarrowed one.
    """

    def test_orders_by_customer(self, client, admin_auth, order, customer):
        everything = client.get("/api/admin/orders", headers=admin_auth).json()["data"]
        theirs = client.get(f"/api/admin/orders?customerId={customer.id}",
                            headers=admin_auth).json()["data"]

        assert [o["id"] for o in theirs] == [
            o["id"] for o in everything if o["customerId"] == customer.id
        ]
        assert theirs

    def test_orders_by_a_customer_with_none(self, client, admin_auth, order, other_customer):
        assert client.get(f"/api/admin/orders?customerId={other_customer.id}",
                          headers=admin_auth).json()["data"] == []

    def test_invoices_by_order(self, client, admin_auth, order):
        rows = client.get(f"/api/admin/billing/invoices?orderId={order['id']}",
                          headers=admin_auth).json()["data"]
        assert [i["id"] for i in rows] == [order["invoiceId"]]

    def test_payments_by_order(self, client, admin_auth, order):
        rows = client.get(f"/api/admin/billing/payments?orderId={order['id']}",
                          headers=admin_auth).json()["data"]
        assert [p["id"] for p in rows] == [order["paymentId"]]

    def test_credit_notes_by_order(self, client, admin_auth, order):
        assert client.get(f"/api/admin/billing/credit-notes?orderId={order['id']}",
                          headers=admin_auth).json()["data"] == []

        created = client.post("/api/admin/billing/credit-notes", headers=admin_auth, json={
            "invoiceId": order["invoiceId"], "total": 50000, "reason": "goodwill",
        })
        assert created.status_code == 201, created.text

        rows = client.get(f"/api/admin/billing/credit-notes?orderId={order['id']}",
                          headers=admin_auth).json()["data"]
        assert [n["id"] for n in rows] == [created.json()["data"]["id"]]

    def test_an_unknown_order_narrows_to_nothing(self, client, admin_auth, order):
        assert client.get("/api/admin/billing/invoices?orderId=ORD999",
                          headers=admin_auth).json()["data"] == []
