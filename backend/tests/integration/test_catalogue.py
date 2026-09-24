"""
The catalogue: listing, filtering, sorting, paging, and what stays hidden.

The filtering tests matter more than they look. Every one of them used to be
done in the browser over a bundled JSON file; they are here because the query
has to mean the same thing now that a database answers it.
"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


def ids(response) -> list[str]:
    return [item["id"] for item in response.json()["data"]]


class TestListing:
    def test_lists_published_products(self, client, catalogue):
        response = client.get("/api/products")
        assert response.status_code == 200
        assert set(ids(response)) == {"PRD001", "PRD002", "PRD003"}

    def test_a_draft_is_not_in_the_shop(self, client, catalogue):
        """PRD004 is a draft. The storefront must not be able to see it at all."""
        assert "PRD004" not in ids(client.get("/api/products"))
        assert client.get("/api/products/PRD004").status_code == 404
        assert client.get("/api/products/slug/draft-jacket").status_code == 404

    def test_the_envelope_carries_pagination(self, client, catalogue):
        body = client.get("/api/products?page=1&pageSize=2").json()
        assert body["success"] is True
        assert body["pagination"]["total"] == 3
        assert body["pagination"]["total_pages"] == 2
        assert len(body["data"]) == 2

    def test_the_total_counts_matches_not_the_page(self, client, catalogue):
        """
        The count is over the *filter*, not the page and not the table.

        This is the assertion that would have caught the subquery bug where
        every search reported the whole catalogue.
        """
        body = client.get("/api/products?search=kurta&pageSize=1").json()
        assert body["pagination"]["total"] == 1

    def test_page_size_is_capped(self, client, catalogue):
        """No single request may ask the server to serialise everything."""
        assert client.get("/api/products?pageSize=5000").status_code == 422


class TestFiltering:
    def test_by_category(self, client, catalogue):
        assert set(ids(client.get("/api/products?category=electronics"))) == {"PRD003"}

    def test_by_search_term(self, client, catalogue):
        assert ids(client.get("/api/products?search=Linen")) == ["PRD002"]

    def test_search_is_case_insensitive(self, client, catalogue):
        assert ids(client.get("/api/products?search=linen")) == ["PRD002"]

    def test_by_price_range(self, client, catalogue):
        assert set(ids(client.get("/api/products?minPrice=1500&maxPrice=2500"))) == {"PRD002"}

    def test_by_minimum_discount(self, client, catalogue):
        assert set(ids(client.get("/api/products?minDiscount=25"))) == {"PRD003"}

    def test_in_stock_only_excludes_the_sold_out_one(self, client, catalogue):
        assert set(ids(client.get("/api/products?inStockOnly=true"))) == {"PRD001", "PRD002"}

    def test_filters_combine(self, client, catalogue):
        response = client.get("/api/products?category=women&inStockOnly=true&maxPrice=1500")
        assert ids(response) == ["PRD001"]

    def test_a_filter_matching_nothing_returns_nothing_not_everything(self, client, catalogue):
        body = client.get("/api/products?search=zzzznothing").json()
        assert body["data"] == []
        assert body["pagination"]["total"] == 0


class TestSorting:
    def test_price_ascending(self, client, catalogue):
        assert ids(client.get("/api/products?sort=price-asc")) == ["PRD001", "PRD002", "PRD003"]

    def test_price_descending(self, client, catalogue):
        assert ids(client.get("/api/products?sort=price-desc")) == ["PRD003", "PRD002", "PRD001"]

    def test_by_discount(self, client, catalogue):
        assert ids(client.get("/api/products?sort=discount"))[0] == "PRD003"

    def test_by_rating(self, client, catalogue):
        assert ids(client.get("/api/products?sort=rating"))[0] == "PRD001"

    def test_an_unknown_sort_is_rejected_not_ignored(self, client, catalogue):
        """
        422, not a 500 and not a silent fallback.

        It used to be neither: the value reached Pydantic inside a dependency
        and came back as "something went wrong on our side".
        """
        assert client.get("/api/products?sort=whatever").status_code == 422

    def test_paging_does_not_lose_or_repeat_a_product(self, client, catalogue):
        """
        Every ordering ends with the id, so it is total.

        Without that, two products at the same price can swap places between
        page one and page two — one appears twice and the other vanishes.
        """
        first = ids(client.get("/api/products?sort=price-asc&pageSize=2&page=1"))
        second = ids(client.get("/api/products?sort=price-asc&pageSize=2&page=2"))
        assert len(set(first + second)) == 3


class TestSingleProduct:
    def test_by_id(self, client, catalogue):
        response = client.get("/api/products/PRD001")
        assert response.status_code == 200
        assert response.json()["data"]["slug"] == "cotton-kurta"

    def test_by_slug(self, client, catalogue):
        response = client.get("/api/products/slug/cotton-kurta")
        assert response.json()["data"]["id"] == "PRD001"

    def test_an_unknown_id_is_a_404_with_a_code(self, client, catalogue):
        response = client.get("/api/products/PRD999")
        assert response.status_code == 404
        assert response.json()["success"] is False
        assert response.json()["error_code"]

    def test_related_products_exclude_the_product_itself(self, client, catalogue):
        response = client.get("/api/products/PRD001/related")
        assert response.status_code == 200
        assert "PRD001" not in ids(response)


class TestFacets:
    def test_facets_describe_the_catalogue(self, client, catalogue):
        response = client.get("/api/products/facets")
        assert response.status_code == 200
        data = response.json()["data"]
        assert "Anvi" in [b["value"] if isinstance(b, dict) else b for b in data["brands"]]

    def test_the_price_range_covers_what_is_on_sale(self, client, catalogue):
        data = client.get("/api/products/facets").json()["data"]
        assert data["priceRange"]["min"] <= 1000
        assert data["priceRange"]["max"] >= 3000


class TestCategories:
    def test_lists_categories(self, client, catalogue):
        response = client.get("/api/categories")
        assert response.status_code == 200
        assert {c["slug"] for c in response.json()["data"]} == {"women", "electronics"}

    def test_by_slug(self, client, catalogue):
        assert client.get("/api/categories/women").json()["data"]["name"] == "Women"

    def test_unknown_category(self, client, catalogue):
        assert client.get("/api/categories/atlantis").status_code == 404
