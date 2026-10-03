"""
Search beyond the listing itself: the search log behind `search.searchId`,
attribute filters and facets the listing tests don't reach (select attributes,
number ranges with their own facet, availability together with attributes),
suggestions (`/api/search/suggest`), click-through (`/api/search/click`), and
the admin side (`/api/admin/search/analytics|settings|rebuild`) with its
`search` permission. See docs/search-and-filters.md §5–§8.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.models import (
    AuditLog,
    ProductAttribute,
    ProductAttributeOption,
    ProductAttributeValue,
    SearchClick,
    SearchDailyStat,
    SearchQuery,
    SettingDocument,
)
from app.services.analytics_events import visitor_key
from app.services.search import analytics, dictionary
from tests.integration.test_attributes_api import login
from tests.integration.test_search_listing import ids, make_order, material, shop  # noqa: F401 - fixtures

pytestmark = pytest.mark.integration

VISITOR = "visitor_abc12345"


def data(response, status=200):
    assert response.status_code == status, response.text
    return response.json()["data"]


def error(response, status, code):
    assert response.status_code == status, response.text
    assert response.json()["error_code"] == code, response.text


def search(client, term, *, headers=None, **params):
    query = "&".join(f"{k}={v}" for k, v in params.items())
    response = client.get(f"/api/products?search={term}" + (f"&{query}" if query else ""), headers=headers or {})
    assert response.status_code == 200, response.text
    return response.json()


def logged(db):
    return list(db.execute(select(SearchQuery).order_by(SearchQuery.id)).scalars())


def click(client, search_id, product_id, position=1, headers=None):
    return client.post("/api/search/click", headers=headers or {},
                       json={"searchId": search_id, "productId": product_id, "position": position})


@pytest.fixture()
def finish(db, material):
    """A single-select `finish` (matte / gloss), on two bottles and the vase."""
    finish = ProductAttribute(code="finish", label="Finish", type="select", position=0)
    finish.options = [ProductAttributeOption(value="matte", label="Matte", position=0),
                      ProductAttributeOption(value="gloss", label="Gloss", position=1),
                      ProductAttributeOption(value="satin", label="Satin", position=2)]
    db.add(finish)
    db.flush()
    for pid, value in (("PRD101", "matte"), ("PRD102", "gloss"), ("PRD105", "gloss"), ("PRD107", "matte")):
        db.add(ProductAttributeValue(product_id=pid, attribute_id=finish.id, value=value.title(),
                                     value_normalized=value))
    db.flush()
    return finish


# ================================================================== the search log


class TestSearchLog:
    def test_page_one_of_a_search_is_logged_with_its_id(self, client, db, shop):
        body = search(client, "%20STEEL%20%20Bottle%20", brands="Steelco", visitorId=VISITOR)
        assert body["search"]["term"] == "steel bottle" and body["search"]["correctedTerm"] is None
        [row] = logged(db)
        assert body["search"]["searchId"] == row.id
        assert (row.term, row.results_count, row.zero_results, row.filters, row.sort) == (
            "steel bottle", body["pagination"]["total"], False, "brand", "relevance")
        assert row.visitor_hash == visitor_key(VISITOR) and VISITOR not in row.visitor_hash
        assert row.customer_id is None

    def test_later_pages_and_plain_listings_are_not_searches(self, client, db, shop):
        assert search(client, "bottle", page=2, pageSize=2)["search"]["searchId"] is None
        assert "search" not in client.get("/api/products?category=kitchen").json()
        client.get("/api/products/facets?search=bottle")
        assert logged(db) == []

    def test_the_same_visitor_repeating_a_search_reuses_the_row(self, client, db, shop):
        first = search(client, "bottle", visitorId=VISITOR)["search"]["searchId"]
        again = search(client, "Bottle", visitorId=VISITOR)["search"]["searchId"]
        other_filters = search(client, "bottle", visitorId=VISITOR, brands="Hydra")["search"]["searchId"]
        other_sort = search(client, "bottle", visitorId=VISITOR, sort="price-asc")["search"]["searchId"]
        assert first == again
        assert len({first, other_filters, other_sort}) == 3
        assert len(logged(db)) == 3

    def test_an_anonymous_search_without_a_visitor_is_never_merged(self, client, db, shop):
        first = search(client, "bottle")["search"]["searchId"]
        second = search(client, "bottle", visitorId="bad id!")["search"]["searchId"]
        assert first != second
        assert {row.visitor_hash for row in logged(db)} == {""}

    def test_a_repeat_after_a_minute_is_a_new_search(self, client, db, shop):
        first = search(client, "bottle", visitorId=VISITOR)["search"]["searchId"]
        db.get(SearchQuery, first).created_at = datetime.utcnow() - timedelta(seconds=90)
        db.flush()
        assert search(client, "bottle", visitorId=VISITOR)["search"]["searchId"] != first

    def test_zero_results_and_corrections_are_recorded(self, client, db, shop):
        dictionary.rebuild(db)
        search(client, "zzzzqqq")
        body = search(client, "cearmic")
        assert body["search"]["correctedTerm"] == "ceramic"
        nothing, corrected = logged(db)
        assert (nothing.zero_results, nothing.results_count, nothing.corrected_term) == (True, 0, "")
        assert (corrected.term, corrected.corrected_term, corrected.zero_results) == ("cearmic", "ceramic", False)

    def test_a_signed_in_search_keeps_the_customer(self, client, db, shop, customer, auth):
        search(client, "bottle", headers=auth, visitorId=VISITOR)
        [row] = logged(db)
        assert row.customer_id == customer.id and row.visitor_hash == visitor_key(customer_id=customer.id)

    def test_attribute_filters_are_named_in_the_log(self, client, db, material):
        search(client, "bottle", **{"attr.material": "steel", "inStockOnly": "true", "minPrice": "100"})
        assert logged(db)[0].filters == "price,availability,attributes"

    def test_public_searches_are_rate_limited(self, client, shop):
        for _ in range(120):
            assert client.get("/api/products?search=jar").status_code == 200
        error(client.get("/api/products?search=jar"), 429, "RATE_LIMITED")
        assert client.get("/api/products?category=kitchen").status_code == 200  # browsing isn't searching


# ================================================================== filters & facets


class TestAttributeListing:
    @pytest.mark.parametrize("query, expected", [
        ("attr.finish=matte", {"PRD101", "PRD107"}),  # PRD107 is out of stock but published
        ("attr.finish=gloss,matte", {"PRD101", "PRD102", "PRD105", "PRD107"}),
        ("attr.finish=matte&availability=out-of-stock", {"PRD107"}),
        ("attr.finish=matte&inStockOnly=true", {"PRD101"}),
        ("attr.finish=matte,gloss&availability=in-stock&attr.capacity.min=900", {"PRD102"}),
        ("attr.material=ceramic&attr.finish=gloss", {"PRD105"}),
        ("attr.finish=satin", set()),
        ("attr.capacity.min=750&attr.capacity.max=750", {"PRD101"}),
        ("attr.capacity.min=1000.5", set()),
        ("attr.capacity.max=-1", set()),
    ])
    def test_filters(self, client, finish, query, expected):
        response = client.get(f"/api/products?{query}")
        assert set(ids(response)) == expected
        assert response.json()["pagination"]["total"] == len(expected)

    def test_repeated_parameters_are_merged(self, client, finish):
        assert set(ids(client.get("/api/products?attr.finish=matte&attr.finish=gloss"))) == {
            "PRD101", "PRD102", "PRD105", "PRD107"}

    def test_an_attribute_filter_combines_with_search(self, client, finish):
        assert ids(client.get("/api/products?search=bottle&attr.finish=gloss")) == ["PRD102"]


class TestAttributeFacets:
    def test_a_select_attribute_lists_options_in_their_order(self, client, finish):
        by_code = {a["code"]: a for a in data(client.get("/api/products/facets"))["attributes"]}
        assert list(by_code)[0] == "finish"  # position 0
        assert by_code["finish"]["type"] == "select" and by_code["finish"]["range"] is None
        # Satin is on nothing, so it isn't offered.
        assert [(o["value"], o["label"], o["count"]) for o in by_code["finish"]["options"]] == [
            ("matte", "Matte", 2), ("gloss", "Gloss", 2)]

    def test_a_number_range_filter_keeps_its_own_range_but_narrows_the_rest(self, client, finish):
        by_code = {a["code"]: a for a in data(client.get("/api/products/facets?attr.capacity.min=900"))["attributes"]}
        assert by_code["capacity"]["range"] == {"min": 500.0, "max": 1000.0}
        assert {o["value"]: o["count"] for o in by_code["material"]["options"]} == {"steel": 1, "glass": 1}
        assert {o["value"]: o["count"] for o in by_code["finish"]["options"]} == {"gloss": 1}

    def test_two_attribute_filters_each_ignore_only_their_own(self, client, finish):
        by_code = {a["code"]: a for a in data(client.get(
            "/api/products/facets?attr.finish=gloss&attr.material=steel"))["attributes"]}
        # material counted with finish=gloss applied: PRD102 (steel, glass) and PRD105 (ceramic).
        assert {o["value"]: o["count"] for o in by_code["material"]["options"]} == {
            "steel": 1, "glass": 1, "ceramic": 1}
        # finish counted with material=steel applied: PRD101 (matte), PRD102 (gloss).
        assert {o["value"]: o["count"] for o in by_code["finish"]["options"]} == {"matte": 1, "gloss": 1}

    def test_attribute_filters_narrow_the_other_dimensions(self, client, finish):
        facets = data(client.get("/api/products/facets?attr.finish=gloss"))
        assert {b["value"]: b["count"] for b in facets["brands"]} == {"Steelco": 1, "Terra": 1}
        assert facets["availability"] == {"inStock": 2, "outOfStock": 0}

    def test_availability_narrows_the_attribute_counts(self, client, finish):
        by_code = {a["code"]: a for a in data(client.get(
            "/api/products/facets?availability=out-of-stock"))["attributes"]}
        assert {o["value"]: o["count"] for o in by_code["finish"]["options"]} == {"matte": 1}  # PRD107
        assert set(by_code) == {"finish"}

    def test_drafts_never_count(self, client, db, finish):
        db.add(ProductAttributeValue(product_id="PRD108", attribute_id=finish.id, value="Satin",
                                     value_normalized="satin"))
        db.flush()
        by_code = {a["code"]: a for a in data(client.get("/api/products/facets"))["attributes"]}
        assert "satin" not in {o["value"] for o in by_code["finish"]["options"]}


# ================================================================== suggestions


@pytest.fixture()
def curated(db):
    db.add(SettingDocument(key="content", value={"popularSearches": ["steel bottle", "glass jar"],
                                                 "heroTitle": "Monsoon"}))
    db.flush()


class TestSuggest:
    def test_a_short_query_only_offers_popular_searches(self, client, shop, curated):
        for q in ("", "s", "%20%20b%20"):
            body = data(client.get(f"/api/search/suggest?q={q}"))
            assert body["products"] == body["categories"] == body["brands"] == []
            assert body["popular"] == ["steel bottle", "glass jar"]

    def test_products_categories_and_brands(self, client, shop):
        body = data(client.get("/api/search/suggest?q=Bottle&limit=2"))
        assert body["query"] == "bottle" and body["correctedTerm"] is None
        # "Bottle Brush" starts with the term (60 + 15 + 8) and outranks "Steel Bottle" (40 + 15 + 8).
        assert [p["id"] for p in body["products"]] == ["PRD104", "PRD101"]
        assert set(body["products"][0]) == {"id", "slug", "name", "brand", "image", "price", "originalPrice"}
        steel = body["products"][1]
        assert steel["price"] == 499.0 and steel["originalPrice"] == 699.0 and steel["slug"] == "steel-bottle-prd101"

    def test_category_and_brand_groups(self, client, shop):
        assert data(client.get("/api/search/suggest?q=kit"))["categories"] == [{"slug": "kitchen", "name": "Kitchen"}]
        assert data(client.get("/api/search/suggest?q=decor"))["categories"] == [
            {"slug": "home-decor", "name": "Home Decor"}]
        assert data(client.get("/api/search/suggest?q=ter"))["brands"] == [{"value": "Terra", "label": "Terra"}]

    def test_drafts_are_never_suggested(self, client, shop):
        body = data(client.get("/api/search/suggest?q=lamp"))
        assert body["products"] == [] and body["brands"] == []

    def test_a_typo_is_corrected(self, client, db, shop):
        dictionary.rebuild(db)
        body = data(client.get("/api/search/suggest?q=cermic"))
        assert body["correctedTerm"] == "ceramic"
        assert [p["id"] for p in body["products"]] == ["PRD105"]

    def test_without_a_dictionary_nothing_is_corrected(self, client, shop):
        body = data(client.get("/api/search/suggest?q=cermic"))
        assert body["correctedTerm"] is None and body["products"] == []

    def test_synonyms_apply(self, client, admin_auth, shop):
        data(client.put("/api/admin/search/settings", headers=admin_auth, json={"synonyms": ["thermos, flask"]}))
        assert [p["id"] for p in data(client.get("/api/search/suggest?q=thermos"))["products"]] == ["PRD109"]

    def test_wildcards_mean_themselves(self, client, shop):
        assert [p["id"] for p in data(client.get("/api/search/suggest?q=50%25"))["products"]] == ["PRD106"]
        assert data(client.get("/api/search/suggest?q=%25%25"))["products"] == []

    def test_suggestions_are_not_logged(self, client, db, shop):
        client.get("/api/search/suggest?q=bottle")
        assert logged(db) == []

    @pytest.mark.parametrize("query", ["limit=0", "limit=11", "q=" + "x" * 101])
    def test_bounds(self, client, shop, query):
        error(client.get(f"/api/search/suggest?{query}"), 422, "VALIDATION_ERROR")

    def test_rate_limited(self, client, shop):
        for _ in range(240):
            client.get("/api/search/suggest?q=b")
        error(client.get("/api/search/suggest?q=b"), 429, "RATE_LIMITED")


class TestPopularMode:
    def stats(self, db, term, searches, zero=0, day=None):
        db.add(SearchDailyStat(day=day or datetime.utcnow().date(), term=term, searches=searches,
                               zero_results=zero, clicked_searches=0, clicks=0, conversions=0, avg_results=1))
        db.flush()

    def test_auto_uses_the_most_searched_terms_that_found_something(self, client, db, admin_auth, shop, curated):
        self.stats(db, "lunch box", 9)
        self.stats(db, "flask", 4)
        self.stats(db, "air fryer", 7, zero=7)      # found nothing every time
        self.stats(db, "lamp", 2)                   # too few
        self.stats(db, "old favourite", 50, day=datetime.utcnow().date() - timedelta(days=40))  # too old
        assert data(client.get("/api/search/suggest"))["popular"] == ["steel bottle", "glass jar"]  # curated
        data(client.put("/api/admin/search/settings", headers=admin_auth, json={"popularMode": "auto"}))
        assert data(client.get("/api/search/suggest"))["popular"] == ["lunch box", "flask"]
        settings = data(client.get("/api/admin/search/settings", headers=admin_auth))
        assert settings["autoPopular"] == ["lunch box", "flask"] and settings["popularMode"] == "auto"

    def test_auto_falls_back_to_the_curated_list_while_there_is_no_data(self, client, admin_auth, shop, curated):
        data(client.put("/api/admin/search/settings", headers=admin_auth, json={"popularMode": "auto"}))
        assert data(client.get("/api/search/suggest"))["popular"] == ["steel bottle", "glass jar"]


# ================================================================== clicks


class TestClicks:
    def test_a_click_is_recorded_once(self, client, db, shop):
        search_id = search(client, "bottle", visitorId=VISITOR)["search"]["searchId"]
        response = click(client, search_id, "PRD104", position=2)
        assert response.status_code == 202 and response.json()["data"] == {"recorded": True}
        assert data(click(client, search_id, "PRD104", position=2), 202) == {"recorded": False}
        [row] = db.execute(select(SearchClick)).scalars().all()
        assert (row.search_id, row.product_id, row.position, row.converted) == (search_id, "PRD104", 2, False)
        assert row.visitor_hash == visitor_key(VISITOR)  # inherited from the search

    def test_a_signed_in_click_keeps_the_customer(self, client, db, shop, customer, auth):
        search_id = search(client, "bottle")["search"]["searchId"]
        assert data(click(client, search_id, "PRD101", headers=auth), 202) == {"recorded": True}
        row = db.execute(select(SearchClick)).scalar_one()
        assert row.customer_id == customer.id and row.visitor_hash == visitor_key(customer_id=customer.id)

    def test_what_does_not_add_up_is_ignored(self, client, db, shop):
        search_id = search(client, "bottle")["search"]["searchId"]
        assert data(click(client, search_id + 1000, "PRD101"), 202) == {"recorded": False}
        assert data(click(client, search_id, "PRD999"), 202) == {"recorded": False}
        db.get(SearchQuery, search_id).created_at = datetime.utcnow() - timedelta(hours=25)
        db.flush()
        assert data(click(client, search_id, "PRD101"), 202) == {"recorded": False}
        assert db.execute(select(func.count(SearchClick.id))).scalar_one() == 0

    @pytest.mark.parametrize("payload", [
        {"searchId": 0, "productId": "PRD101", "position": 1},
        {"searchId": 1, "productId": "PRD101", "position": 0},
        {"searchId": 1, "productId": "", "position": 1},
        {"searchId": 1, "productId": "P" * 21, "position": 1},
        {"searchId": 1, "productId": "PRD101", "position": 100_001},
        {"productId": "PRD101", "position": 1},
    ])
    def test_validation(self, client, shop, payload):
        error(client.post("/api/search/click", json=payload), 422, "VALIDATION_ERROR")

    def test_rate_limited(self, client, shop):
        for _ in range(120):
            client.post("/api/search/click", json={"searchId": 999999, "productId": "PRD101", "position": 1})
        error(client.post("/api/search/click", json={"searchId": 999999, "productId": "PRD101", "position": 1}),
              429, "RATE_LIMITED")


class TestConversions:
    def test_an_order_within_a_day_converts_the_click(self, client, db, shop, customer, auth):
        search_id = search(client, "bottle", headers=auth)["search"]["searchId"]
        data(click(client, search_id, "PRD101", headers=auth), 202)
        data(click(client, search_id, "PRD109", headers=auth), 202)
        row_time = db.execute(select(SearchClick.created_at).where(SearchClick.product_id == "PRD101")).scalar_one()
        make_order(db, "ORD701", customer.id, "confirmed", [("PRD101", 1)], placed_at=row_time + timedelta(hours=2))
        make_order(db, "ORD702", customer.id, "cancelled", [("PRD109", 1)], placed_at=row_time + timedelta(hours=2))
        assert analytics.mark_conversions(db) == 1
        converted = {c.product_id: c.converted for c in db.execute(select(SearchClick)).scalars()}
        assert converted == {"PRD101": True, "PRD109": False}
        report = data(client.get("/api/admin/search/analytics?range=7d",
                                 headers=self.admin_headers(client, db)))
        assert report["totals"]["conversions"] == 1 and report["totals"]["conversionRate"] == 100.0

    def admin_headers(self, client, db):
        return login(client, db, admin_id="ADM020", email="search.lead@example.com", role="manager",
                     permissions=["search"])

    def test_a_guest_click_never_converts(self, client, db, shop, customer):
        search_id = search(client, "bottle")["search"]["searchId"]
        data(click(client, search_id, "PRD101"), 202)
        make_order(db, "ORD703", customer.id, "confirmed", [("PRD101", 1)], placed_at=datetime.utcnow())
        assert analytics.mark_conversions(db) == 0


# ================================================================== analytics


class TestAnalyticsReport:
    def test_the_report_counts_today(self, client, db, admin_auth, shop):
        first = search(client, "bottle", visitorId="visitor_one_1")["search"]["searchId"]
        search(client, "bottle", visitorId="visitor_two_2")
        search(client, "jar", visitorId="visitor_one_1")
        search(client, "air fryer", visitorId="visitor_one_1")
        data(click(client, first, "PRD101", position=1), 202)
        data(click(client, first, "PRD104", position=4), 202)

        report = data(client.get("/api/admin/search/analytics?range=7d", headers=admin_auth))
        today = datetime.utcnow().date()
        assert report["range"] == "7d" and report["to"] == today.isoformat()
        assert report["from"] == (today - timedelta(days=6)).isoformat()
        assert report["totals"] == {"searches": 4, "uniqueTerms": 3, "zeroResultSearches": 1, "zeroResultRate": 25.0,
                                    "clicks": 2, "ctr": 25.0, "conversions": 0, "conversionRate": 0.0}
        assert report["topSearches"][0] == {"term": "bottle", "searches": 2, "clicks": 2, "ctr": 50.0,
                                            "conversions": 0, "avgResults": 5.0}
        assert [t["term"] for t in report["topSearches"]] == ["bottle", "air fryer", "jar"]
        assert report["zeroResults"] == [{"term": "air fryer", "searches": 1, "lastSearchedAt": today.isoformat()}]
        assert len(report["series"]) == 7 and report["series"][-1] == {
            "date": today.isoformat(), "searches": 4, "zeroResults": 1, "clicks": 2}
        assert all(day["searches"] == 0 for day in report["series"][:-1])

    def test_the_default_range_is_thirty_days(self, client, admin_auth, shop):
        report = data(client.get("/api/admin/search/analytics", headers=admin_auth))
        assert report["range"] == "30d" and len(report["series"]) == 30
        assert report["totals"]["searches"] == 0 and report["totals"]["ctr"] == 0.0

    def test_an_unknown_range_is_a_422(self, client, admin_auth, shop):
        error(client.get("/api/admin/search/analytics?range=1y", headers=admin_auth), 422, "VALIDATION_ERROR")

    def test_trending_compares_with_the_period_before(self, client, db, admin_auth, shop):
        today = datetime.utcnow().date()

        def stats(term, searches, days_ago):
            db.add(SearchDailyStat(day=today - timedelta(days=days_ago), term=term, searches=searches,
                                   zero_results=0, clicked_searches=0, clicks=0, conversions=0, avg_results=2))

        stats("diwali lamp", 6, 2)
        stats("diwali lamp", 2, 10)     # the week before
        stats("steel bottle", 4, 1)
        stats("steel bottle", 5, 9)     # fell: not trending
        stats("rakhi", 3, 3)            # new this week
        stats("glass jar", 2, 1)        # under 3 searches
        stats("ancient", 9, 30)         # outside both windows
        db.flush()
        report = data(client.get("/api/admin/search/analytics?range=7d", headers=admin_auth))
        assert report["trending"] == [
            {"term": "rakhi", "searches": 3, "previous": 0, "change": None},
            {"term": "diwali lamp", "searches": 6, "previous": 2, "change": 200.0},
        ]
        assert report["totals"]["searches"] == 15 and report["totals"]["uniqueTerms"] == 4

    def test_the_dashboard_summary(self, client, db, shop):
        search(client, "bottle")
        search(client, "zzzzqqq")
        summary = analytics.summary(db)
        assert summary["searchesToday"] == 2 and summary["zeroResultSearchesToday"] == 1
        assert {t["term"] for t in summary["topSearches"]} == {"bottle", "zzzzqqq"}


# ================================================================== settings


class TestSettings:
    def test_defaults(self, client, admin_auth, shop):
        assert data(client.get("/api/admin/search/settings", headers=admin_auth)) == {
            "popularMode": "curated", "popularSearches": [], "autoPopular": [], "synonyms": [],
            "lastRebuildAt": None, "dictionarySize": 0}

    def test_saving_everything(self, client, db, admin_auth, shop, curated):
        body = data(client.put("/api/admin/search/settings", headers=admin_auth, json={
            "popularMode": "auto", "popularSearches": [" lunch  box ", "Lunch Box", "flask"],
            "synonyms": [["Tee", "T-Shirt"], "sofa = couch, settee"]}))
        assert body["popularMode"] == "auto"
        assert body["popularSearches"] == ["lunch box", "flask"]
        assert body["synonyms"] == [["tee", "t-shirt"], ["sofa", "couch", "settee"]]
        # The curated list lives in the content document, beside whatever else is there.
        content = db.get(SettingDocument, "content").value
        assert content == {"popularSearches": ["lunch box", "flask"], "heroTitle": "Monsoon"}
        assert db.get(SettingDocument, "search").value["synonyms"] == [["tee", "t-shirt"],
                                                                       ["sofa", "couch", "settee"]]
        [entry] = db.execute(select(AuditLog).where(AuditLog.action == "search.settings")).scalars().all()
        assert entry.changes == {"fields": ["popular_mode", "popular_searches", "synonyms"]}

    def test_saving_one_field_keeps_the_others(self, client, admin_auth, shop, curated):
        data(client.put("/api/admin/search/settings", headers=admin_auth, json={"synonyms": [["sofa", "couch"]]}))
        body = data(client.put("/api/admin/search/settings", headers=admin_auth, json={"popularMode": "auto"}))
        assert body["synonyms"] == [["sofa", "couch"]] and body["popularSearches"] == ["steel bottle", "glass jar"]

    def test_synonyms_can_be_cleared(self, client, admin_auth, shop):
        data(client.put("/api/admin/search/settings", headers=admin_auth, json={"synonyms": [["flask", "thermos"]]}))
        assert data(client.put("/api/admin/search/settings", headers=admin_auth, json={"synonyms": []}))[
            "synonyms"] == []
        assert ids(client.get("/api/products?search=thermos")) == []

    @pytest.mark.parametrize("payload, code", [
        ({"synonyms": [["two words", "pair"]]}, "INVALID_SYNONYMS"),
        ({"synonyms": [[f"w{i}" for i in range(11)]]}, "INVALID_SYNONYMS"),
        ({"synonyms": [[f"a{i}", f"b{i}"] for i in range(201)]}, "INVALID_SYNONYMS"),
        ({"popularSearches": ["x" * 61]}, "INVALID_POPULAR_SEARCHES"),
        ({"popularSearches": [f"term {i}" for i in range(21)]}, "INVALID_POPULAR_SEARCHES"),
        ({"popularMode": "sometimes"}, "VALIDATION_ERROR"),
        ({"popularSearches": [f"t{i}" for i in range(51)]}, "VALIDATION_ERROR"),
    ])
    def test_refused_and_nothing_is_written(self, client, db, admin_auth, shop, payload, code):
        error(client.put("/api/admin/search/settings", headers=admin_auth, json=payload), 422, code)
        assert db.get(SettingDocument, "search") is None and db.get(SettingDocument, "content") is None

    def test_a_bad_synonym_list_does_not_half_save_the_popular_list(self, client, db, admin_auth, shop, curated):
        error(client.put("/api/admin/search/settings", headers=admin_auth, json={
            "popularSearches": ["new"], "synonyms": [["two words", "x"]]}), 422, "INVALID_SYNONYMS")
        db.expire_all()
        assert db.get(SettingDocument, "content").value["popularSearches"] == ["steel bottle", "glass jar"]


class TestRebuild:
    def test_rebuild_fills_the_dictionary_and_stamps_the_time(self, client, db, admin_auth, shop, customer):
        make_order(db, "ORD801", customer.id, "delivered", [("PRD103", 2)])
        body = data(client.post("/api/admin/search/rebuild", headers=admin_auth))
        assert body["products"] == 9 and body["unitsSold"] == 1 and body["terms"] == dictionary.size(db) > 10
        settings = data(client.get("/api/admin/search/settings", headers=admin_auth))
        assert settings["dictionarySize"] == body["terms"]
        assert datetime.fromisoformat(settings["lastRebuildAt"]) >= datetime.utcnow().replace(microsecond=0) \
            - timedelta(minutes=1)
        [entry] = db.execute(select(AuditLog).where(AuditLog.action == "search.rebuild")).scalars().all()
        assert "9 products" in entry.summary
        assert ids(client.get("/api/products?sort=best-selling"))[0] == "PRD103"

    def test_rebuild_drops_words_nobody_uses(self, client, db, admin_auth, shop):
        dictionary.add_words(db, ["zanzibar"])
        assert dictionary.correct(db, "zanzibr") == "zanzibar"
        data(client.post("/api/admin/search/rebuild", headers=admin_auth))
        assert dictionary.correct(db, "zanzibr") is None


# ================================================================== who may


class TestSearchPermission:
    ENDPOINTS = (
        ("get", "/api/admin/search/analytics", None),
        ("get", "/api/admin/search/settings", None),
        ("put", "/api/admin/search/settings", {"popularMode": "auto"}),
        ("post", "/api/admin/search/rebuild", None),
    )

    def call(self, client, headers, method, path, body):
        return getattr(client, method)(path, headers=headers, **({"json": body} if body is not None else {}))

    def test_a_staff_admin_without_search_is_refused(self, client, db, shop):
        headers = login(client, db, admin_id="ADM030", email="staff.member@example.com", role="staff",
                        permissions=["products", "orders"])
        for method, path, body in self.ENDPOINTS:
            error(self.call(client, headers, method, path, body), 403, "PERMISSION_DENIED")
        assert db.get(SettingDocument, "search") is None
        assert dictionary.size(db) == 0
        # ...while what `products` covers stays open to them.
        assert client.get("/api/admin/attributes", headers=headers).status_code == 200

    def test_the_refusal_is_audited(self, client, db, shop):
        headers = login(client, db, admin_id="ADM031", email="staff.two@example.com", role="staff",
                        permissions=["products"])
        client.post("/api/admin/search/rebuild", headers=headers)
        denied = db.execute(select(AuditLog).where(AuditLog.outcome == "denied")).scalars().all()
        assert [d.actor_id for d in denied] == ["ADM031"]

    def test_a_permission_granted_on_the_account_is_enough(self, client, db, shop):
        headers = login(client, db, admin_id="ADM032", email="staff.three@example.com", role="staff",
                        permissions=["products", "search"])
        for method, path, body in self.ENDPOINTS:
            assert self.call(client, headers, method, path, body).status_code == 200, path

    def test_the_editor_role_includes_search(self, client, db, editor, shop):
        from tests.conftest import ADMIN_PASSWORD

        token = client.post("/api/admin/auth/login", json={"email": editor.email, "password": ADMIN_PASSWORD})
        headers = {"Authorization": f"Bearer {token.json()['data']['token']['accessToken']}"}
        assert client.get("/api/admin/search/analytics", headers=headers).status_code == 200

    def test_customers_and_strangers_are_refused(self, client, auth, shop):
        for method, path, body in self.ENDPOINTS:
            assert self.call(client, auth, method, path, body).status_code in (401, 403)
            assert self.call(client, {}, method, path, body).status_code == 401
