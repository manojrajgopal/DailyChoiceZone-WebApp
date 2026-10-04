"""
Search & filters on the listing: relevance ranking, wildcard escaping, the
typo fallback, synonyms, every filter (multi-category, brands, availability,
attributes), disjunctive facets, the new sorts, paging and validation.
See docs/search-and-filters.md.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.models import (
    Category,
    Collection,
    CollectionProduct,
    Order,
    OrderItem,
    Product,
    ProductAttribute,
    ProductAttributeOption,
    ProductAttributeValue,
    ProductColor,
    ProductSize,
    ProductTag,
)
from app.services.search import dictionary, index, jobs

pytestmark = pytest.mark.integration


def ids(response):
    assert response.status_code == 200, response.text
    return [p["id"] for p in response.json()["data"]]


def _product(pid, name, *, category="CAT010", brand="Steelco", price=500, original=None, stock=10, reserved=0,
             status="active", rating=4.0, reviews=0, sku=None, description="", subcategory="bottles", **extra):
    return Product(id=pid, slug=name.lower().replace(" ", "-").replace("%", "pct") + f"-{pid.lower()}",
                   sku=sku or f"SKU-{pid}", name=name, brand=brand, category_id=category, subcategory=subcategory,
                   price=price, original_price=original or price,
                   discount=round((1 - price / (original or price)) * 100), stock=stock, reserved_stock=reserved,
                   status=status, rating=rating, review_count=reviews, description=description, **extra)


def make_order(db, oid, customer_id, status, lines, placed_at=None):
    """A bare order with lines, for the units-sold and conversion tests."""
    db.add(Order(id=oid, order_number=f"DCZ{oid}", customer_id=customer_id, customer_name="Asha Rao",
                 customer_email="shopper@example.com", placed_at=placed_at or datetime.utcnow(), status=status,
                 payment_status="paid", payment_method="cod"))
    db.flush()
    for pid, quantity in lines:
        db.add(OrderItem(order_id=oid, product_id=pid, name="x", sku="x", quantity=quantity, unit_price=1,
                         line_total=quantity))
    db.flush()


@pytest.fixture()
def shop(db):
    """A small kitchen-and-home catalogue where every ranking and filter has a known answer."""
    db.add_all([
        Category(id="CAT010", slug="kitchen", name="Kitchen", display_order=1),
        Category(id="CAT011", slug="home-decor", name="Home Decor", display_order=2),
        Category(id="CAT012", slug="garden", name="Garden", display_order=3),
    ])
    db.flush()
    products = [
        _product("PRD101", "Steel Bottle", price=499, original=699, rating=4.6, reviews=12,
                 description="A double-walled bottle.", created_at=datetime(2026, 1, 1)),
        _product("PRD102", "Insulated Steel Bottle Pro", price=899, original=999, rating=4.1, reviews=3,
                 created_at=datetime(2026, 2, 1)),
        _product("PRD103", "Glass Jar", brand="Clearware", price=299, rating=3.2, subcategory="jars",
                 description="Keeps things fresh. Pairs well with a steel bottle.", created_at=datetime(2026, 3, 1)),
        _product("PRD104", "Bottle Brush", brand="Steelco", price=149, rating=3.9, subcategory="cleaning",
                 stock=4, reserved=4, created_at=datetime(2026, 4, 1)),
        _product("PRD105", "Ceramic Vase", category="CAT011", brand="Terra", price=1499, original=2999, rating=4.8,
                 subcategory="vases", created_at=datetime(2026, 5, 1)),
        _product("PRD106", "50% Off Sign", category="CAT011", brand="Terra", price=99, subcategory="signs",
                 created_at=datetime(2026, 6, 1)),
        _product("PRD107", "Plant_Pot Large", category="CAT012", brand="Greenly", price=799, stock=0,
                 status="out-of-stock", subcategory="pots", created_at=datetime(2026, 7, 1)),
        _product("PRD108", "Draft Lamp", category="CAT011", brand="Terra", price=2500, status="draft",
                 subcategory="lamps"),
        _product("PRD109", "Water Flask", brand="Hydra", price=650, rating=4.4, sku="FLK-2000",
                 created_at=datetime(2026, 8, 1)),
    ]
    db.add_all(products)
    db.flush()
    db.add_all([
        ProductTag(product_id="PRD109", tag="bottle"),
        ProductTag(product_id="PRD103", tag="storage"),
        ProductSize(product_id="PRD101", label="500ml", position=0),
        ProductSize(product_id="PRD101", label="1L", position=1),
        ProductSize(product_id="PRD102", label="1L", position=0),
        ProductColor(product_id="PRD101", name="Silver", hex="#c0c0c0", position=0),
        ProductColor(product_id="PRD102", name="Black", hex="#000000", position=0),
        ProductColor(product_id="PRD105", name="Silver", hex="#c0c0c0", position=0),
    ])
    db.flush()
    return {p.id: p for p in products}


@pytest.fixture()
def material(db, shop):
    """A multi-select `material`, a number `capacity` (ml) and a boolean `dishwasher_safe`."""
    material = ProductAttribute(code="material", label="Material", type="multi", position=1)
    material.options = [ProductAttributeOption(value="steel", label="Steel", position=0),
                        ProductAttributeOption(value="glass", label="Glass", position=1),
                        ProductAttributeOption(value="ceramic", label="Ceramic", position=2)]
    capacity = ProductAttribute(code="capacity", label="Capacity", type="number", unit="ml", position=2)
    dishwasher = ProductAttribute(code="dishwasher_safe", label="Dishwasher safe", type="boolean", position=3)
    hidden = ProductAttribute(code="internal", label="Internal", type="select", filterable=False, position=4)
    hidden.options = [ProductAttributeOption(value="x", label="X", position=0)]
    db.add_all([material, capacity, dishwasher, hidden])
    db.flush()

    def value(pid, attribute, normalized, label, number=None):
        db.add(ProductAttributeValue(product_id=pid, attribute_id=attribute.id, value=label,
                                     value_normalized=normalized, value_number=number))

    value("PRD101", material, "steel", "Steel")
    value("PRD102", material, "steel", "Steel")
    value("PRD102", material, "glass", "Glass")
    value("PRD103", material, "glass", "Glass")
    value("PRD105", material, "ceramic", "Ceramic")
    value("PRD101", capacity, "750", "750", 750)
    value("PRD102", capacity, "1000", "1000", 1000)
    value("PRD109", capacity, "500", "500", 500)
    value("PRD101", dishwasher, "true", "Yes")
    value("PRD103", dishwasher, "true", "Yes")
    value("PRD102", dishwasher, "false", "No")
    value("PRD101", hidden, "x", "X")
    db.flush()
    return {"material": material, "capacity": capacity, "dishwasher": dishwasher}


# ================================================================== ranking


class TestRelevance:
    def test_an_exact_name_beats_a_prefix_beats_a_word_inside_beats_a_tag_beats_the_description(self, client, shop):
        found = ids(client.get("/api/products?search=steel bottle"))
        # Exact name, then the name that contains the phrase, then "Bottle Brush" (its brand Steelco starts
        # with "steel" — a brand prefix counts, docs/search-and-filters.md §2), then the description-only match.
        assert found == ["PRD101", "PRD102", "PRD104", "PRD103"]

    def test_a_name_prefix_outranks_a_tag_match(self, client, shop):
        found = ids(client.get("/api/products?search=bottle"))
        assert found.index("PRD104") < found.index("PRD109")  # "Bottle Brush" starts with it; the flask is tagged
        assert set(found) == {"PRD101", "PRD102", "PRD103", "PRD104", "PRD109"}

    def test_an_exact_sku_comes_first(self, client, shop):
        assert ids(client.get("/api/products?search=flk-2000"))[0] == "PRD109"

    def test_a_sku_prefix_matches(self, client, shop):
        assert ids(client.get("/api/products?search=FLK-2")) == ["PRD109"]

    def test_brand_matches(self, client, shop):
        assert set(ids(client.get("/api/products?search=terra"))) == {"PRD105", "PRD106"}

    def test_case_does_not_matter(self, client, shop):
        assert ids(client.get("/api/products?search=STEEL BOTTLE")) == ids(client.get("/api/products?search=steel bottle"))

    def test_category_and_collection_names_match_through_the_index(self, client, db, shop):
        db.add(Collection(id="COL010", slug="monsoon", name="Monsoon Picks"))
        db.flush()
        db.add(CollectionProduct(collection_id="COL010", product_id="PRD105", position=0))
        db.flush()
        index.rebuild(db)
        assert ids(client.get("/api/products?search=monsoon")) == ["PRD105"]
        assert set(ids(client.get("/api/products?search=decor"))) == {"PRD105", "PRD106"}

    def test_attribute_values_match_through_the_index(self, client, db, material):
        index.rebuild(db)
        assert "PRD105" in ids(client.get("/api/products?search=ceramic"))

    def test_an_explicit_sort_overrides_relevance(self, client, shop):
        assert ids(client.get("/api/products?search=bottle&sort=price-asc"))[0] == "PRD104"

    def test_relevance_without_a_term_is_recommended(self, client, shop):
        assert ids(client.get("/api/products?sort=relevance")) == ids(client.get("/api/products?sort=recommended"))

    def test_a_draft_is_never_found(self, client, shop):
        assert ids(client.get("/api/products?search=lamp")) == []

    def test_relevance_paging_is_total(self, client, shop):
        pages = [ids(client.get(f"/api/products?search=bottle&pageSize=2&page={page}")) for page in (1, 2, 3)]
        flat = [pid for page in pages for pid in page]
        assert len(flat) == len(set(flat)) == 5


class TestWildcards:
    def test_a_percent_sign_means_itself(self, client, shop):
        assert ids(client.get("/api/products?search=50%25")) == ["PRD106"]

    def test_an_underscore_means_itself(self, client, shop):
        assert ids(client.get("/api/products?search=plant_pot")) == ["PRD107"]
        assert ids(client.get("/api/products?search=plant_po_")) == []

    def test_a_lone_percent_does_not_match_everything(self, client, shop):
        assert ids(client.get("/api/products?search=%25")) == ["PRD106"]

    def test_the_escape_character_itself(self, client, shop):
        assert ids(client.get("/api/products?search=!")) == []


class TestTypoFallback:
    def test_a_misspelt_term_finds_the_corrected_one(self, client, db, shop):
        dictionary.rebuild(db)
        body = client.get("/api/products?search=stel botle").json()
        assert body["search"]["correctedTerm"] == "steel bottle"
        assert [p["id"] for p in body["data"]][0] == "PRD101"

    def test_a_swap_of_two_letters_is_one_edit(self, client, db, shop):
        dictionary.rebuild(db)
        body = client.get("/api/products?search=cearmic").json()
        assert body["search"]["correctedTerm"] == "ceramic"

    def test_a_term_that_finds_something_is_not_corrected(self, client, db, shop):
        dictionary.rebuild(db)
        body = client.get("/api/products?search=jar").json()
        assert body["search"]["correctedTerm"] is None and [p["id"] for p in body["data"]] == ["PRD103"]

    def test_nothing_close_stays_empty(self, client, db, shop):
        dictionary.rebuild(db)
        body = client.get("/api/products?search=zzzzqqq").json()
        assert body["data"] == [] and body["search"]["correctedTerm"] is None

    def test_an_empty_dictionary_just_finds_nothing(self, client, shop):
        body = client.get("/api/products?search=stel").json()
        assert body["data"] == [] and body["search"]["correctedTerm"] is None

    def test_facets_use_the_correction_too(self, client, db, shop):
        dictionary.rebuild(db)
        data = client.get("/api/products/facets?search=bottel").json()["data"]
        assert {b["value"] for b in data["brands"]} >= {"Steelco"}

    def test_short_words_are_not_corrected(self, db, shop):
        dictionary.rebuild(db)
        assert dictionary.correct(db, "xq") is None


class TestSynonyms:
    def test_a_synonym_finds_the_other_word(self, client, db, admin_auth, shop):
        response = client.put("/api/admin/search/settings", headers=admin_auth,
                              json={"synonyms": [["flask", "thermos"]]})
        assert response.status_code == 200, response.text
        assert ids(client.get("/api/products?search=thermos")) == ["PRD109"]


# ================================================================== filters


class TestFilters:
    @pytest.mark.parametrize("query, expected", [
        ("category=kitchen", {"PRD101", "PRD102", "PRD103", "PRD104", "PRD109"}),
        ("category=kitchen,garden", {"PRD101", "PRD102", "PRD103", "PRD104", "PRD109", "PRD107"}),
        ("category=CAT011,garden", {"PRD105", "PRD106", "PRD107"}),
        ("subcategory=jars,vases", {"PRD103", "PRD105"}),
        ("brands=Terra,Hydra", {"PRD105", "PRD106", "PRD109"}),
        ("sizes=1L", {"PRD101", "PRD102"}),
        ("colors=Silver", {"PRD101", "PRD105"}),
        ("minPrice=300&maxPrice=900", {"PRD101", "PRD102", "PRD107", "PRD109"}),
        ("minRating=4.5", {"PRD101", "PRD105"}),
        ("rating=4.5", {"PRD101", "PRD105"}),
        ("minDiscount=40", {"PRD105"}),
        ("availability=out-of-stock", {"PRD104", "PRD107"}),
        ("category=kitchen&brands=Steelco&minPrice=400", {"PRD101", "PRD102"}),
    ])
    def test_the_filter_narrows(self, client, shop, query, expected):
        response = client.get(f"/api/products?{query}")
        assert set(ids(response)) == expected
        assert response.json()["pagination"]["total"] == len(expected)

    def test_in_stock_means_available_stock(self, client, shop):
        """PRD104 has 4 on the shelf, all 4 held for payments: not in stock (was `stock > 0`)."""
        found = set(ids(client.get("/api/products?inStockOnly=true")))
        assert "PRD104" not in found and "PRD107" not in found
        assert found == set(ids(client.get("/api/products?availability=in-stock")))

    def test_a_single_category_string_still_works_in_the_query(self, db, shop):
        from app.repositories import products as repo
        from app.schemas.catalogue import ProductQuery

        items, total = repo.query_products(db, ProductQuery(category="garden"))
        assert [p.id for p in items] == ["PRD107"] and total == 1


class TestAttributeFilters:
    @pytest.mark.parametrize("query, expected", [
        ("attr.material=steel", {"PRD101", "PRD102"}),
        ("attr.material=steel,glass", {"PRD101", "PRD102", "PRD103"}),
        ("attr.material=glass&attr.dishwasher_safe=true", {"PRD103"}),
        ("attr.dishwasher_safe=false", {"PRD102"}),
        ("attr.capacity.min=600", {"PRD101", "PRD102"}),
        ("attr.capacity.min=600&attr.capacity.max=900", {"PRD101"}),
        ("attr.capacity.max=500", {"PRD109"}),
        ("attr.material=STEEL", {"PRD101", "PRD102"}),
    ])
    def test_attribute_filters(self, client, material, query, expected):
        assert set(ids(client.get(f"/api/products?{query}"))) == expected

    @pytest.mark.parametrize("query", [
        "attr.nonexistent=1", "attr.internal=x", "attr.capacity.min=lots", "attr.capacity.median=3",
        "attr.=x", "attr.dishwasher_safe=perhaps", "attr.material=",
    ])
    def test_junk_and_unknown_attribute_filters_are_ignored(self, client, material, query):
        assert len(ids(client.get(f"/api/products?{query}"))) == 8

    def test_archived_attributes_do_not_filter(self, client, db, material):
        material["material"].status = "archived"
        db.flush()
        assert len(ids(client.get("/api/products?attr.material=steel"))) == 8

    def test_many_attribute_parameters_are_bounded(self, client, material):
        junk = "&".join(f"attr.code{i}=v" for i in range(40))
        assert client.get(f"/api/products?{junk}&attr.material=steel").status_code == 200


class TestValidation:
    @pytest.mark.parametrize("query", [
        "minPrice=-1", "maxPrice=20000000", "minRating=6", "rating=-2", "minDiscount=101", "availability=soon",
        "sort=cheapest", "page=0", "pageSize=101", "search=" + "x" * 201,
    ])
    def test_out_of_bounds_is_a_422(self, client, shop, query):
        response = client.get(f"/api/products?{query}")
        assert response.status_code == 422, response.text
        assert response.json()["error_code"] == "VALIDATION_ERROR"

    def test_too_many_values_is_a_422(self, client, shop):
        many = ",".join(f"b{i}" for i in range(51))
        assert client.get(f"/api/products?brands={many}").status_code == 422
        assert client.get(f"/api/products/facets?brands={many}").status_code == 422

    def test_an_overlong_value_is_a_422(self, client, shop):
        assert client.get("/api/products?category=" + "c" * 121).status_code == 422

    def test_hostile_input_is_never_a_500(self, client, shop):
        for query in ("search=%27%20OR%201%3D1%20--", "search=%00%E2%80%AE", "category=%25", "attr.material=%25",
                      "search=___", "brands=,,,", "attr.capacity.min=nan", "attr.capacity.min=inf"):
            assert client.get(f"/api/products?{query}").status_code == 200, query
            assert client.get(f"/api/products/facets?{query}").status_code == 200, query

    def test_an_inverted_price_range_is_simply_empty(self, client, shop):
        assert ids(client.get("/api/products?minPrice=900&maxPrice=100")) == []


# ================================================================== sorting


class TestSorts:
    @pytest.mark.parametrize("sort, first, last", [
        ("newest", "PRD109", "PRD101"),
        ("oldest", "PRD101", "PRD109"),
        ("price-asc", "PRD106", "PRD105"),
        ("price-desc", "PRD105", "PRD106"),
        ("discount", "PRD105", None),
        ("rating", "PRD105", None),
        ("popular", "PRD101", None),
    ])
    def test_sort_orders(self, client, shop, sort, first, last):
        found = ids(client.get(f"/api/products?sort={sort}"))
        assert found[0] == first
        if last:
            assert found[-1] == last

    def test_availability_puts_what_can_be_bought_first(self, client, shop):
        found = ids(client.get("/api/products?sort=availability"))
        assert set(found[-2:]) == {"PRD104", "PRD107"}

    def test_best_selling_reads_units_sold(self, client, db, shop, customer):
        order = lambda oid, status, lines: make_order(db, oid, customer.id, status, lines)  # noqa: E731
        order("ORD901", "delivered", [("PRD103", 5), ("PRD106", 1)])
        order("ORD902", "confirmed", [("PRD106", 2)])
        order("ORD903", "cancelled", [("PRD109", 50)])  # cancelled: never counted
        order("ORD904", "pending", [("PRD101", 40)])  # awaiting payment: not yet a sale
        db.flush()
        index.rebuild(db)
        found = ids(client.get("/api/products?sort=best-selling"))
        assert found[:2] == ["PRD103", "PRD106"]

    def test_best_selling_without_any_index_rows_still_answers(self, client, shop):
        assert len(ids(client.get("/api/products?sort=best-selling"))) == 8

    @pytest.mark.parametrize("sort", ["recommended", "newest", "price-asc", "price-desc", "rating", "popular",
                                      "discount", "relevance", "oldest", "best-selling", "availability"])
    def test_every_sort_pages_without_overlap(self, client, shop, sort):
        pages = [ids(client.get(f"/api/products?sort={sort}&pageSize=3&page={page}")) for page in (1, 2, 3)]
        flat = [pid for page in pages for pid in page]
        assert len(flat) == len(set(flat)) == 8


class TestPaging:
    def test_past_the_end_is_empty(self, client, shop):
        body = client.get("/api/products?search=bottle&page=50").json()
        assert body["data"] == [] and body["pagination"]["total"] == 5

    def test_the_last_partial_page(self, client, shop):
        body = client.get("/api/products?pageSize=3&page=3").json()
        assert len(body["data"]) == 2 and body["pagination"]["total_pages"] == 3


# ================================================================== facets


class TestFacets:
    def test_counts_are_disjunctive(self, client, shop):
        """Ticking Terra still shows the other brands' counts; it narrows the categories."""
        data = client.get("/api/products/facets?brands=Terra").json()["data"]
        brands = {b["value"]: b["count"] for b in data["brands"]}
        assert brands == {"Steelco": 3, "Clearware": 1, "Terra": 2, "Greenly": 1, "Hydra": 1}
        assert {c["value"]: c["count"] for c in data["categories"]} == {"home-decor": 2}

    def test_ticking_a_category_keeps_the_other_categories(self, client, shop):
        data = client.get("/api/products/facets?category=garden").json()["data"]
        assert {c["value"]: c["count"] for c in data["categories"]} == {"kitchen": 5, "home-decor": 2, "garden": 1}
        assert {b["value"] for b in data["brands"]} == {"Greenly"}

    def test_subcategories_carry_their_parent_and_colours_their_swatch(self, client, shop):
        data = client.get("/api/products/facets").json()["data"]
        assert {"value": "vases", "label": "vases", "count": 1, "parent": "home-decor", "hex": None} in data["subcategories"]
        assert {c["value"]: c["hex"] for c in data["colors"]} == {"Black": "#000000", "Silver": "#c0c0c0"}

    def test_price_buckets_ratings_discounts_and_availability(self, client, shop):
        data = client.get("/api/products/facets").json()["data"]
        assert [b["count"] for b in data["priceBuckets"]] == [4, 3, 1, 0, 0]
        assert data["priceBuckets"][-1]["max"] is None
        # "4★ & above" is rating >= 4: PRD101, 102, 105, 109, and PRD106/107 at the default 4.0.
        assert {r["value"]: r["count"] for r in data["ratings"]} == {"4": 6, "3": 8}
        assert {d["value"]: d["count"] for d in data["discounts"]}["10"] == 3
        assert data["availability"] == {"inStock": 6, "outOfStock": 2}

    def test_the_price_dimension_ignores_its_own_filter_but_not_others(self, client, shop):
        data = client.get("/api/products/facets?minPrice=1000&category=kitchen").json()["data"]
        assert sum(b["count"] for b in data["priceBuckets"]) == 5
        assert data["priceRange"] == {"min": 149.0, "max": 899.0}

    def test_availability_counts_ignore_the_availability_filter(self, client, shop):
        data = client.get("/api/products/facets?inStockOnly=true").json()["data"]
        assert data["availability"] == {"inStock": 6, "outOfStock": 2}
        assert sum(b["count"] for b in data["brands"]) == 6

    def test_attribute_facets(self, client, material):
        data = client.get("/api/products/facets").json()["data"]
        by_code = {a["code"]: a for a in data["attributes"]}
        assert set(by_code) == {"material", "capacity", "dishwasher_safe"}  # not the unfilterable one
        assert [(o["value"], o["label"], o["count"]) for o in by_code["material"]["options"]] == [
            ("steel", "Steel", 2), ("glass", "Glass", 2), ("ceramic", "Ceramic", 1)]
        assert by_code["capacity"]["range"] == {"min": 500.0, "max": 1000.0} and by_code["capacity"]["unit"] == "ml"
        assert [(o["value"], o["label"], o["count"]) for o in by_code["dishwasher_safe"]["options"]] == [
            ("true", "Yes", 2), ("false", "No", 1)]

    def test_attribute_facets_are_disjunctive(self, client, material):
        data = client.get("/api/products/facets?attr.material=ceramic").json()["data"]
        by_code = {a["code"]: a for a in data["attributes"]}
        # Its own options keep their counts...
        assert {o["value"]: o["count"] for o in by_code["material"]["options"]} == {"steel": 2, "glass": 2,
                                                                                     "ceramic": 1}
        # ...the others narrow to the vase, which has no capacity or dishwasher value.
        assert "capacity" not in by_code and "dishwasher_safe" not in by_code

    def test_facets_with_an_empty_scope(self, client, shop):
        data = client.get("/api/products/facets?search=zzzz").json()["data"]
        assert data["brands"] == [] and data["attributes"] == []
        assert data["priceRange"] == {"min": 0.0, "max": 0.0}
        assert data["availability"] == {"inStock": 0, "outOfStock": 0}

    def test_the_facet_query_count_is_bounded(self, client, db, material):
        """One grouped query per dimension: about a dozen, whatever the catalogue size."""
        from sqlalchemy import event

        statements = []

        def count(*_args, **_kwargs):
            statements.append(1)

        engine = db.get_bind()
        event.listen(engine, "before_cursor_execute", count)
        try:
            client.get("/api/products/facets?attr.material=steel&brands=Steelco")
        finally:
            event.remove(engine, "before_cursor_execute", count)
        assert len(statements) <= 20


# ================================================================== the portal list


class TestAdminList:
    def test_server_side_id_filter_status_and_counts(self, client, admin_auth, shop):
        body = client.get("/api/admin/products?q=PRD108", headers=admin_auth).json()
        assert [p["id"] for p in body["data"]] == ["PRD108"]
        assert body["counts"]["draft"] == 1 and body["counts"]["all"] == 1

    def test_the_id_filter_takes_a_sku_and_is_exact(self, client, admin_auth, shop):
        assert ids(client.get("/api/admin/products?q=FLK-2000", headers=admin_auth)) == ["PRD109"]
        assert ids(client.get("/api/admin/products?q=prd109", headers=admin_auth)) == ["PRD109"]
        # PRD10 is the start of nine IDs, but no product's ID.
        assert ids(client.get("/api/admin/products?q=PRD10", headers=admin_auth)) == []

    def test_names_brands_and_free_text_find_nothing(self, client, admin_auth, shop):
        assert ids(client.get("/api/admin/products?q=Lamp", headers=admin_auth)) == []
        assert ids(client.get("/api/admin/products?q=Terra", headers=admin_auth)) == []
        assert ids(client.get("/api/admin/products?q=Draft%20Lamp", headers=admin_auth)) == []
        # The storefront's free-text search is not a portal filter: it is ignored here.
        assert len(ids(client.get("/api/admin/products?search=lamp", headers=admin_auth))) == 9

    def test_counts_ignore_the_status_filter(self, client, admin_auth, shop):
        body = client.get("/api/admin/products?status=draft", headers=admin_auth).json()
        assert [p["id"] for p in body["data"]] == ["PRD108"]
        assert body["counts"] == {"all": 9, "active": 7, "draft": 1, "out-of-stock": 1, "archived": 0}

    def test_filter_options(self, client, admin_auth, shop):
        filters = client.get("/api/admin/products", headers=admin_auth).json()["filters"]
        assert {"value": "kitchen", "label": "Kitchen"} in filters["categories"]
        assert "Terra" in filters["brands"]

    @pytest.mark.parametrize("stock, expected", [
        ("out-of-stock", {"PRD104", "PRD107"}),
        ("low-stock", set()),
        ("in-stock", {"PRD101", "PRD102", "PRD103", "PRD105", "PRD106", "PRD108", "PRD109"}),
    ])
    def test_stock_levels(self, client, admin_auth, shop, stock, expected):
        assert set(ids(client.get(f"/api/admin/products?stock={stock}", headers=admin_auth))) == expected

    def test_low_stock(self, client, db, admin_auth, shop):
        shop["PRD103"].stock = 3
        db.flush()
        assert ids(client.get("/api/admin/products?stock=low-stock", headers=admin_auth)) == ["PRD103"]

    @pytest.mark.parametrize("sort, first", [("name-asc", "PRD106"), ("name-desc", "PRD109"),
                                             ("stock-asc", "PRD104"), ("price-desc", "PRD108")])
    def test_admin_sorts(self, client, admin_auth, shop, sort, first):
        assert ids(client.get(f"/api/admin/products?sort={sort}", headers=admin_auth))[0] == first

    def test_the_storefront_search_never_matches_a_barcode(self, client, db, admin_auth, shop):
        shop["PRD105"].barcode = "8901234567890"
        db.flush()
        assert ids(client.get("/api/products?search=890123456")) == []

    def test_paging_and_bounds(self, client, admin_auth, shop):
        body = client.get("/api/admin/products?pageSize=4&page=3&sort=name-asc", headers=admin_auth).json()
        assert len(body["data"]) == 1 and body["pagination"]["total"] == 9
        assert client.get("/api/admin/products?pageSize=101", headers=admin_auth).status_code == 422
        assert client.get("/api/admin/products?sort=nope", headers=admin_auth).status_code == 422
        assert client.get("/api/admin/products?stock=some", headers=admin_auth).status_code == 422

    def test_customers_cannot_read_it(self, client, auth, shop):
        assert client.get("/api/admin/products", headers=auth).status_code in (401, 403)


class TestTheIndexStaysCurrent:
    def test_saving_a_product_refreshes_its_search_text(self, client, db, admin_auth, shop):
        response = client.put("/api/products/PRD103", headers=admin_auth,
                              json={"specifications": [{"label": "Seal", "value": "Airtight silicone"}]})
        assert response.status_code == 200, response.text
        assert ids(client.get("/api/products?search=silicone")) == ["PRD103"]

    def test_a_new_product_adds_its_words_to_the_dictionary(self, client, db, admin_auth, shop):
        response = client.post("/api/products", headers=admin_auth,
                               json={"name": "Terracotta Planter", "category": "garden", "price": 400,
                                     "status": "active", "stock": 3})
        assert response.status_code == 201, response.text
        assert dictionary.correct(db, "terracota") == "terracotta"

    def test_an_index_failure_never_fails_the_save(self, client, db, admin_auth, shop, monkeypatch):
        def broken(*_args, **_kwargs):
            raise RuntimeError("index down")

        monkeypatch.setattr(index, "refresh", broken)
        response = client.put("/api/products/PRD101", headers=admin_auth, json={"name": "Steel Bottle 2"})
        assert response.status_code == 200 and response.json()["data"]["name"] == "Steel Bottle 2"

    def test_the_rebuild_job_fills_everything(self, db, shop):
        result = jobs.rebuild(db)
        assert result["products"] == 9 and result["terms"] > 10
