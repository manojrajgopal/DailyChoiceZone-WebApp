"""
Analytics, the edges: periods (custom, year to date, the limits), comparisons
(none, last year — including 29 February), granularity and its buckets, the
short-lived cache, every CSV export, and the older dashboard figures in
`services.analytics`. Orders are written directly so the arithmetic is
checkable without going through checkout.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest

from app.core import rate_limit
from app.core.errors import ValidationError
from app.models import AnalyticsEvent, Customer, Order, OrderItem
from app.services import analytics, analytics_events, insights

pytestmark = pytest.mark.integration

IST = insights.IST


@pytest.fixture(autouse=True)
def _fresh():
    rate_limit.reset()
    insights.clear_cache()
    yield
    insights.clear_cache()
    rate_limit.reset()


def order(db, oid, *, customer_id="CUS001", total=1000.0, status="confirmed", placed_at=None, coupon=None,
          items=(("PRD001", 1, 1000.0),), bundle_id=None, method="upi", payment_status="paid"):
    db.add(Order(id=oid, order_number=f"DCZ-A-{oid}", customer_id=customer_id, customer_name="Asha Rao",
                 customer_email="shopper@example.com", placed_at=placed_at or datetime.utcnow() - timedelta(hours=1),
                 status=status, payment_status=payment_status, payment_method=method, total=total, subtotal=total,
                 item_count=sum(q for _, q, _ in items), coupon_code=coupon, coupon_discount=50 if coupon else 0,
                 shipping_state="Karnataka"))
    db.flush()
    for product_id, quantity, line_total in items:
        db.add(OrderItem(order_id=oid, product_id=product_id, name=f"Item {product_id}", sku=f"SKU-{product_id}",
                         quantity=quantity, unit_price=line_total / quantity, line_total=line_total,
                         bundle_id=bundle_id, bundle_group="g1" if bundle_id else "",
                         bundle_quantity=1 if bundle_id else 0))
    db.flush()


@pytest.fixture()
def sales(db, catalogue, customer):
    order(db, "ORDA01", total=2000.0, items=(("PRD001", 2, 2000.0),), coupon="SAVE10")
    order(db, "ORDA02", total=3000.0, items=(("PRD003", 1, 3000.0),), method="cod", payment_status="cod-pending")
    order(db, "ORDA03", total=999.0, status="cancelled")
    return db


# ------------------------------------------------------------------ periods


class TestPeriods:
    def test_a_custom_range_needs_real_dates(self):
        with pytest.raises(ValidationError) as error:
            insights.period("custom", "2026-13-01", "2026-12-31")
        assert error.value.error_code == "INVALID_RANGE"
        with pytest.raises(ValidationError):
            insights.period("custom", None, None)

    def test_a_custom_range_is_at_most_two_years(self):
        with pytest.raises(ValidationError, match="two years"):
            insights.period("custom", "2024-01-01", "2026-01-02")
        p = insights.period("custom", "2024-01-01", "2025-12-31")
        assert p.days == 731

    def test_year_to_date(self):
        p = insights.period("ytd", now=datetime(2026, 10, 2, 12, 0))
        assert p.label == "Year to date"
        assert p.view()["startDate"] == "2026-01-01" and p.view()["endDate"] == "2026-10-02"
        assert p.start == datetime(2026, 1, 1) - IST

    def test_an_unknown_period(self):
        with pytest.raises(ValidationError, match="Unknown period"):
            insights.period("fortnight")

    def test_the_preset_labels_and_lengths(self):
        now = datetime(2026, 10, 2, 12, 0)
        assert insights.period("today", now=now).days == 1
        assert insights.period("12m", now=now).label == "Last 12 months"


class TestComparisons:
    def test_none(self):
        assert insights.comparison(insights.period("7d"), "none") is None

    def test_the_same_period_last_year(self):
        p = insights.period("custom", "2026-05-01", "2026-05-31")
        before = insights.comparison(p, "year")
        assert before.label == "Same period last year"
        assert before.view()["startDate"] == "2025-05-01" and before.view()["endDate"] == "2025-05-31"

    def test_29_february_falls_back_to_the_28th(self):
        p = insights.period("custom", "2028-02-29", "2028-02-29")
        before = insights.comparison(p, "year")
        assert before.view()["startDate"] == "2027-02-28"

    def test_an_unknown_comparison(self):
        with pytest.raises(ValidationError) as error:
            insights.comparison(insights.period("7d"), "decade")
        assert error.value.error_code == "INVALID_COMPARE"


class TestGranularityAndBuckets:
    def test_an_explicit_unit_wins(self):
        assert insights.granularity(insights.period("7d"), "month") == "month"

    @pytest.mark.parametrize("start, end, unit", [("2026-01-01", "2026-03-01", "day"),
                                                  ("2026-01-01", "2026-06-01", "week"),
                                                  ("2025-01-01", "2026-06-01", "month")])
    def test_the_automatic_unit_follows_the_length(self, start, end, unit):
        assert insights.granularity(insights.period("custom", start, end)) == unit

    def test_weeks_start_on_monday_and_months_on_the_first(self):
        p = insights.period("custom", "2026-01-07", "2026-03-15")
        weeks = insights._buckets(p, "week")
        assert weeks[0] == date(2026, 1, 5) and all(d.weekday() == 0 for d in weeks)
        assert weeks[1] - weeks[0] == timedelta(days=7)
        assert insights._buckets(p, "month") == [date(2026, 1, 1), date(2026, 2, 1), date(2026, 3, 1)]

    def test_dates_from_the_database_are_read_whatever_their_type(self):
        assert insights._as_date(datetime(2026, 5, 1, 13, 0)) == date(2026, 5, 1)
        assert insights._as_date(date(2026, 5, 1)) == date(2026, 5, 1)
        assert insights._as_date("2026-05-01") == date(2026, 5, 1)

    def test_a_change_needs_something_to_compare_against(self):
        assert insights.delta(10, None) is None
        assert insights.delta(10, 0) is None
        assert insights.delta(15, 10) == 50.0 and insights.delta(5, -10) == 150.0


class TestCache:
    def test_a_second_ask_within_the_minute_is_served_from_the_cache(self, db):
        calls = []
        assert insights.cached(db, ("k",), lambda: calls.append(1) or "first") == "first"
        assert insights.cached(db, ("k",), lambda: calls.append(1) or "second") == "first"
        assert calls == [1]

    def test_a_new_order_changes_the_answer(self, db, catalogue, customer):
        assert insights.cached(db, ("k",), lambda: "before") == "before"
        order(db, "ORDC01")
        assert insights.cached(db, ("k",), lambda: "after") == "after"

    def test_the_cache_is_bounded(self, db):
        for index in range(205):
            insights._cache[("filler", index)] = (0.0, index)  # long expired
        insights.cached(db, ("fresh",), lambda: "value")
        assert len(insights._cache) == 1

    def test_when_nothing_has_expired_the_oldest_hundred_go(self, db):
        import time

        for index in range(205):
            insights._cache[("filler", index)] = (time.monotonic() + 600, index)
        insights.cached(db, ("fresh",), lambda: "value")
        assert len(insights._cache) == 106 and ("filler", 0) not in insights._cache


# ------------------------------------------------------------------ reports


class TestReports:
    def test_an_unknown_report(self, client, admin_auth):
        response = client.get("/api/admin/analytics/weather", headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_REPORT"

    def test_sales_without_a_comparison(self, client, sales, admin_auth):
        data = client.get("/api/admin/analytics/sales?range=7d&compare=none&unit=day",
                          headers=admin_auth).json()["data"]
        assert data["comparison"] is None and data["granularity"] == "day"
        assert data["metrics"]["revenue"]["value"] == 5000.0
        assert data["metrics"]["revenue"]["previous"] is None and data["metrics"]["revenue"]["delta"] is None

    def test_new_signups_are_counted_in_their_bucket(self, client, db, sales, admin_auth):
        now = datetime.utcnow()
        for index in range(2):
            db.add(Customer(id=f"CUS1{index:02d}", email=f"new{index}@example.com", password_hash="x",
                            first_name="New", last_name="Person", phone="", status="active",
                            joined_at=now - timedelta(hours=2)))
        db.flush()
        data = client.get("/api/admin/analytics/customers?range=7d&unit=week", headers=admin_auth).json()["data"]
        assert data["granularity"] == "week"
        assert sum(b["value"] for b in data["signupSeries"]) == 2
        assert data["metrics"]["signups"]["value"] == 2
        assert data["topCustomers"][0]["id"] == "CUS001" and data["topCustomers"][0]["revenue"] == 5000.0
        assert data["lifetimeValue"] == 5000.0

    def test_bundles_sold_are_summed_per_bundle(self, client, db, catalogue, customer, admin_auth):
        order(db, "ORDB01", total=2500.0, items=(("PRD001", 1, 1000.0), ("PRD002", 1, 1500.0)), bundle_id=77)
        order(db, "ORDB02", total=2500.0, items=(("PRD001", 1, 1000.0), ("PRD002", 1, 1500.0)), bundle_id=77)
        data = client.get("/api/admin/analytics/marketing?range=7d", headers=admin_auth).json()["data"]
        assert data["bundles"] == [{"id": 77, "name": "Bundle 77", "orders": 2, "units": 2, "revenue": 5000.0}]

    def test_the_funnel_without_a_comparison_has_no_previous_counts(self, client, sales, admin_auth):
        data = client.get("/api/admin/analytics/funnel?range=7d&compare=none", headers=admin_auth).json()["data"]
        assert all("previous" not in s for s in data["stages"])
        assert data["conversionRate"] is None  # no visits recorded, none invented

    def test_the_funnel_against_last_year(self, client, sales, admin_auth):
        data = client.get("/api/admin/analytics/funnel?range=7d&compare=year", headers=admin_auth).json()["data"]
        assert data["comparison"]["label"] == "Same period last year"
        purchase = next(s for s in data["stages"] if s["key"] == "purchase")
        assert purchase["count"] == 1 and purchase["previous"] == 0 and purchase["delta"] is None


class TestExports:
    def csv(self, client, headers, kind, query="range=7d"):
        response = client.get(f"/api/admin/analytics/export/{kind}?{query}", headers=headers)
        assert response.status_code == 200, response.text
        assert response.headers["content-type"].startswith("text/csv")
        assert f'filename="{kind}-' in response.headers["content-disposition"]
        return response.text.strip().splitlines()

    def test_an_unknown_export(self, client, admin_auth):
        response = client.get("/api/admin/analytics/export/everything", headers=admin_auth)
        assert response.status_code == 422 and response.json()["error_code"] == "INVALID_EXPORT"

    def test_the_breakdowns(self, client, sales, admin_auth):
        categories = self.csv(client, admin_auth, "categories")
        assert categories[0] == "label,revenue,orders_or_units,share_percent"
        assert {line.split(",")[0] for line in categories[1:]} == {"Women", "Electronics"}
        methods = self.csv(client, admin_auth, "payment-methods")
        assert len(methods) == 3  # UPI and cash on delivery; the cancelled order is not revenue
        assert sorted(float(line.rsplit(",", 1)[1]) for line in methods[1:]) == [40.0, 60.0]
        states = self.csv(client, admin_auth, "states")
        assert states[1].startswith("Karnataka,")

    def test_products_customers_and_coupons(self, client, sales, admin_auth):
        products = self.csv(client, admin_auth, "products")
        assert products[0].startswith("product_id,name,units,revenue")
        assert {line.split(",")[0] for line in products[1:]} == {"PRD001", "PRD003"}
        customers = self.csv(client, admin_auth, "customers")
        assert customers[1].startswith("CUS001,Asha Rao,shopper@example.com,5000.0,2")
        coupons = self.csv(client, admin_auth, "coupons")
        assert coupons == ["code,orders,discount,revenue", "SAVE10,1,50.0,2000.0"]

    def test_flash_sales_bundles_and_the_funnel(self, client, sales, admin_auth):
        assert self.csv(client, admin_auth, "flash-sales") == ["sale_id,name,units,revenue,customer_savings"]
        assert self.csv(client, admin_auth, "bundles") == ["bundle_id,name,orders,units,revenue"]
        funnel = self.csv(client, admin_auth, "funnel")
        assert funnel[0] == "stage,count,percent_of_previous,percent_of_visitors,previous_period"
        assert len(funnel) == 7 and funnel[-1].startswith("Completed a purchase,1")

    def test_a_cell_that_looks_like_a_formula_is_neutralised(self, client, db, catalogue, admin_auth):
        db.add(Customer(id="CUS050", email="formula@example.com", password_hash="x", first_name="=HYPERLINK(1)",
                        last_name="", phone="", status="active", joined_at=datetime(2026, 1, 1)))
        db.flush()
        order(db, "ORDF01", customer_id="CUS050", total=100.0, items=(("PRD001", 1, 100.0),))
        customers = self.csv(client, admin_auth, "customers")
        assert any(",'=HYPERLINK(1)," in line for line in customers)


# ------------------------------------------------------- dashboard figures


class TestDashboardFigures:
    def test_the_report_page_figures_for_all_time(self, sales):
        data = analytics.analytics(sales, "all")
        assert data["range"] == "all" and data["revenue"] == 5000.0 and data["orders"] == 2
        assert data["revenueDelta"] is None  # nothing before "all time"
        assert sum(p["revenue"] for p in data["series"]) == 5000.0
        assert {c["label"]: c["value"] for c in data["byCategory"]} == {"Electronics": 3000.0, "Women": 2000.0}
        top = data["topProducts"][0]
        assert top["productId"] == "PRD003" and top["stock"] == 0
        assert {s["label"]: s["value"] for s in data["orderStatus"]} == {"confirmed": 2, "cancelled": 1}

    def test_a_movement_against_the_period_before(self, sales):
        order(sales, "ORDP01", total=2500.0, placed_at=datetime.utcnow() - timedelta(days=40))
        summary = analytics.sales_summary(sales, "30d")
        assert summary["revenue"] == 5000.0 and summary["revenueDelta"] == 100.0
        assert summary["ordersDelta"] == 100.0 and summary["averageOrderValue"] == 2500.0

    def test_an_unknown_range_means_thirty_days(self, sales):
        start, end = analytics.window("forever", now=datetime(2026, 10, 2))
        assert end - start == timedelta(days=30)
        assert analytics.order_status_breakdown(sales, "7d")[0]["value"] >= 1

    def test_only_known_server_events_are_recorded(self, db):
        analytics_events.server_event(db, "purchase", customer_id="CUS001")
        db.flush()
        assert db.query(AnalyticsEvent).count() == 0
        analytics_events.server_event(db, "add_to_cart", customer_id=None, product_id="PRD001", quantity=-3)
        db.flush()
        row = db.query(AnalyticsEvent).one()
        assert row.quantity == 0 and row.visitor_id == ""
