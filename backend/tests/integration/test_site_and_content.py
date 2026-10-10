"""
The storefront's chrome and the portal's content screens: site configuration,
the menu, the homepage, banners, categories and collections, the admin
notification tray, reports, and the two sign-out calls.

Each endpoint is checked for its answer, its refusals (no token, wrong actor,
missing permission, missing record) and, where it writes, what it wrote.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.models import Banner, Category, Collection, HomepageSection, Notification, Product

pytestmark = pytest.mark.integration


@pytest.fixture()
def editor_auth(client, editor):
    response = client.post("/api/admin/auth/login", json={"email": editor.email, "password": "Admin@123"})
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


@pytest.fixture()
def staff_auth(client, db):
    """A role without `content` or `products` writes: `reviews` only."""
    from app.core.security import hash_password
    from app.models import AdminUser

    db.add(AdminUser(id="ADM020", email="staff@example.com", password_hash=hash_password("Admin@123"), name="Sam",
                     role="staff", permissions=["reviews"], status="active", created_at=datetime(2026, 1, 1)))
    db.flush()
    response = client.post("/api/admin/auth/login", json={"email": "staff@example.com", "password": "Admin@123"})
    return {"Authorization": f"Bearer {response.json()['data']['token']['accessToken']}"}


# ------------------------------------------------------------- site (public)


class TestSiteConfig:
    def test_config_reads_the_store_settings(self, client, settings_documents):
        data = client.get("/api/site/config").json()["data"]
        assert data["freeDeliveryThreshold"] == 999 and data["standardDeliveryFee"] == 79
        assert set(data["support"]) == {"email", "phone", "hours"}
        assert data["returnWindowDays"] == 15

    def test_config_on_an_empty_store_uses_defaults(self, client):
        response = client.get("/api/site/config")
        assert response.status_code == 200
        assert response.json()["data"]["freeDeliveryThreshold"] == 999

    def test_social_links_are_repointed_at_the_settings(self, client, db, settings_documents):
        from app.models import SettingDocument

        db.add(SettingDocument(key="site", value={"name": "Old", "social": [
            {"label": "Instagram", "href": "https://old.test", "icon": "ig"},
            {"label": "Twitter", "href": ""},
        ]}))
        store = db.get(SettingDocument, "store")
        store.value = {**store.value, "social": {"instagram": "https://ig.test/dcz"},
                       "general": {"storeName": "DCZ"}}
        db.flush()
        data = client.get("/api/site/config").json()["data"]
        assert data["name"] == "DCZ"
        assert data["social"] == [{"label": "Instagram", "href": "https://ig.test/dcz", "icon": "ig"}]

    def test_content_points_delivery_fees_at_the_store_settings(self, client, db, settings_documents):
        from app.models import SettingDocument

        db.add(SettingDocument(key="content", value={
            "deliveryMethods": [{"id": "standard", "fee": 1}, {"id": "express", "fee": 2}],
            "paymentMethods": [{"id": "upi"}, {"id": "cod"}],
        }))
        db.flush()
        data = client.get("/api/site/content").json()["data"]
        fees = {m["id"]: m["fee"] for m in data["deliveryMethods"]}
        assert fees == {"standard": 79, "express": 149}
        assert data["enabledPaymentMethods"] == ["card", "cod", "upi"]

    def test_content_without_enabled_methods_offers_every_method(self, client, db):
        from app.models import SettingDocument

        db.add(SettingDocument(key="content", value={"paymentMethods": [{"id": "upi"}, {"id": "cod"}]}))
        db.flush()
        assert client.get("/api/site/content").json()["data"]["enabledPaymentMethods"] == ["upi", "cod"]

    def test_navigation(self, client, db):
        from app.models import SettingDocument

        assert client.get("/api/site/navigation").json() == {"success": True, "data": []}
        db.add(SettingDocument(key="navigation", value={"items": [{"label": "Women", "href": "/category/women"}]}))
        db.flush()
        assert client.get("/api/site/navigation").json()["data"][0]["label"] == "Women"

    def test_billing_and_tax_config_are_public(self, client, settings_documents):
        assert client.get("/api/site/billing-config").status_code == 200
        tax = client.get("/api/site/tax-config").json()["data"]
        assert tax["gstin"] == "29AABCD1234E1Z5"


def _section(id_, order, active=True, **config):
    return HomepageSection(id=id_, type="product-rail", title=id_.title(), subtitle="", source="new",
                           item_limit=8, config=config, active=active, display_order=order)


class TestHomepage:
    @pytest.fixture()
    def sections(self, db):
        db.add_all([_section("trending", 2), _section("hero", 1, layout="wide"), _section("hidden", 0, active=False)])
        db.flush()

    def test_public_homepage_is_live_sections_in_order(self, client, sections):
        sections_out = client.get("/api/site/homepage").json()["data"]["sections"]
        assert [s["id"] for s in sections_out] == ["hero", "trending"]
        assert sections_out[0]["layout"] == "wide"  # config is flattened in
        assert sections_out[0]["limit"] == 8

    def test_admin_sees_hidden_sections_too(self, client, admin_auth, sections):
        ids = [s["id"] for s in client.get("/api/admin/homepage", headers=admin_auth).json()["data"]]
        assert ids == ["hidden", "hero", "trending"]

    def test_rearrange_and_toggle_in_one_call(self, client, admin_auth, sections):
        response = client.put("/api/admin/homepage", headers=admin_auth, json=[
            {"id": "hidden", "active": True, "displayOrder": 9, "title": "Now shown"},
            {"id": "hero", "active": False, "subtitle": "s"},
            {"id": "does-not-exist", "active": True},
        ])
        assert response.status_code == 200
        assert response.json()["message"] == "Homepage updated."
        live = [s["id"] for s in client.get("/api/site/homepage").json()["data"]["sections"]]
        assert live == ["trending", "hidden"]

    def test_rearranging_needs_content_permission(self, client, staff_auth, sections):
        response = client.put("/api/admin/homepage", headers=staff_auth, json=[{"id": "hero", "active": False}])
        assert response.status_code == 403
        assert response.json()["error_code"] == "PERMISSION_DENIED"

    def test_body_must_be_a_list(self, client, admin_auth, sections):
        assert client.put("/api/admin/homepage", headers=admin_auth, json={"id": "hero"}).status_code == 422

    def test_customers_cannot_read_the_admin_homepage(self, client, auth):
        assert client.get("/api/admin/homepage", headers=auth).status_code == 403


class TestBanners:
    def test_create_list_update_delete(self, client, admin_auth):
        created = client.post("/api/admin/banners", headers=admin_auth, json={
            "title": "Diwali sale", "buttonLink": "/sale", "displayOrder": 2})
        assert created.status_code == 201
        banner = created.json()["data"]
        assert banner["id"].startswith("BNR") and banner["title"] == "Diwali sale" and banner["active"] is True

        listed = client.get("/api/admin/banners", headers=admin_auth).json()["data"]
        assert [b["id"] for b in listed] == [banner["id"]]

        updated = client.put(f"/api/admin/banners/{banner['id']}", headers=admin_auth,
                             json={"title": "Diwali sale - last day", "active": False, "subtitle": None})
        assert updated.json()["data"]["title"] == "Diwali sale - last day"
        assert updated.json()["data"]["active"] is False

        assert client.delete(f"/api/admin/banners/{banner['id']}", headers=admin_auth).status_code == 200
        assert client.get("/api/admin/banners", headers=admin_auth).json()["data"] == []

    def test_public_strip_shows_only_live_banners(self, client, db):
        now = datetime.utcnow()
        db.add_all([
            Banner(id="BNR001", title="Live", starts_at=now - timedelta(days=1), ends_at=None, active=True,
                   display_order=1, button_link="/live"),
            Banner(id="BNR002", title="Ended", starts_at=now - timedelta(days=3), ends_at=now - timedelta(days=1),
                   active=True, display_order=2),
            Banner(id="BNR003", title="Future", starts_at=now + timedelta(days=1), active=True, display_order=3),
            Banner(id="BNR004", title="Off", starts_at=now - timedelta(days=1), active=False, display_order=4),
        ])
        db.flush()
        assert client.get("/api/site/banners").json()["data"] == [
            {"id": "BNR001", "message": "Live", "href": "/live"}]

    @pytest.mark.parametrize("method", ["put", "delete"])
    def test_missing_banner(self, client, admin_auth, method):
        kwargs = {"json": {"title": "x"}} if method == "put" else {}
        response = getattr(client, method)("/api/admin/banners/BNR999", headers=admin_auth, **kwargs)
        assert response.status_code == 404
        assert response.json()["error_code"] == "BANNER_NOT_FOUND"

    def test_invalid_date(self, client, admin_auth):
        response = client.post("/api/admin/banners", headers=admin_auth, json={"title": "x", "startsAt": "soon"})
        assert response.status_code == 422

    def test_writing_needs_content_permission(self, client, staff_auth):
        assert client.post("/api/admin/banners", headers=staff_auth, json={"title": "x"}).status_code == 403

    def test_reading_needs_a_token(self, client):
        assert client.get("/api/admin/banners").status_code == 401


# ---------------------------------------------------------- categories


class TestCategories:
    def test_public_list_with_and_without_counts(self, client, catalogue):
        plain = client.get("/api/categories").json()["data"]
        assert [c["slug"] for c in plain] == ["women", "electronics"]
        assert plain[0]["productCount"] is None
        counted = {c["slug"]: c["productCount"] for c in
                   client.get("/api/categories", params={"withCounts": True}).json()["data"]}
        # Drafts are not counted; out-of-stock products are.
        assert counted == {"women": 2, "electronics": 1}

    @pytest.mark.parametrize("identifier", ["CAT001", "women"])
    def test_get_by_id_or_slug(self, client, catalogue, identifier):
        assert client.get(f"/api/categories/{identifier}").json()["data"]["id"] == "CAT001"

    def test_missing(self, client, catalogue):
        response = client.get("/api/categories/nope")
        assert response.status_code == 404 and response.json()["error_code"] == "CATEGORY_NOT_FOUND"

    def test_empty_store(self, client):
        assert client.get("/api/categories").json()["data"] == []

    def test_create_gets_the_next_id_and_a_slug(self, client, admin_auth, catalogue):
        response = client.post("/api/admin/categories", headers=admin_auth, json={
            "name": "Home & Living", "description": "d", "order": 3, "featured": True,
            "groups": [{"name": "Decor", "items": [{"slug": "lamps", "name": "Lamps"}]}]})
        assert response.status_code == 201
        data = response.json()["data"]
        assert data["id"] == "CAT003" and data["slug"] == "home-and-living"
        assert data["order"] == 3 and data["featured"] is True
        assert data["groups"][0]["items"][0]["slug"] == "lamps"

    def test_clashing_slugs_are_numbered(self, client, admin_auth, catalogue):
        first = client.post("/api/admin/categories", headers=admin_auth, json={"name": "Women"}).json()["data"]
        second = client.post("/api/admin/categories", headers=admin_auth, json={"name": "Women"}).json()["data"]
        assert (first["slug"], second["slug"]) == ("women-2", "women-3")

    def test_a_name_is_required(self, client, admin_auth):
        response = client.post("/api/admin/categories", headers=admin_auth, json={"description": "x"})
        assert response.status_code == 422 and response.json()["error_code"] == "CATEGORY_INCOMPLETE"

    def test_unpronounceable_name_still_gets_a_slug(self, client, admin_auth):
        assert client.post("/api/admin/categories", headers=admin_auth,
                           json={"name": "!!!"}).json()["data"]["slug"] == "category"

    def test_update_keeps_its_own_slug(self, client, admin_auth, catalogue):
        response = client.put("/api/admin/categories/CAT001", headers=admin_auth,
                              json={"name": "Womenswear", "slug": "women"})
        data = response.json()["data"]
        assert data["name"] == "Womenswear" and data["slug"] == "women"

    def test_update_missing(self, client, admin_auth):
        assert client.put("/api/admin/categories/CAT999", headers=admin_auth, json={"name": "x"}).status_code == 404

    def test_delete_refused_while_products_use_it(self, client, admin_auth, catalogue):
        response = client.delete("/api/admin/categories/CAT002", headers=admin_auth)
        assert response.status_code == 409 and response.json()["error_code"] == "CATEGORY_IN_USE"
        assert "1 product" in response.json()["message"]

    def test_delete_an_empty_category(self, client, admin_auth, db):
        db.add(Category(id="CAT010", slug="empty", name="Empty"))
        db.flush()
        assert client.delete("/api/admin/categories/CAT010", headers=admin_auth).status_code == 200
        db.expire_all()
        assert db.get(Category, "CAT010") is None

    def test_editor_may_manage_categories(self, client, editor_auth):
        assert client.post("/api/admin/categories", headers=editor_auth, json={"name": "Kids"}).status_code == 201

    def test_without_products_permission(self, client, staff_auth, catalogue):
        staff_cannot = client.post("/api/admin/categories", headers=staff_auth, json={"name": "Kids"})
        # staff's role table includes products; the stored list doesn't, and this route reads the stored list.
        assert staff_cannot.status_code == 403

    def test_customer_cannot(self, client, auth):
        assert client.post("/api/admin/categories", headers=auth, json={"name": "Kids"}).status_code == 403


# ---------------------------------------------------------- collections


class TestCollections:
    def test_create_with_products_in_order_dropping_unknown_and_repeated(self, client, admin_auth, catalogue):
        response = client.post("/api/admin/collections", headers=admin_auth, json={
            "name": "Festive Edit", "tagline": "t", "featured": True,
            "productIds": ["PRD002", "PRD999", "PRD001", "PRD002"]})
        assert response.status_code == 201
        data = response.json()["data"]
        assert data["id"] == "COL001" and data["slug"] == "festive-edit"
        assert data["productIds"] == ["PRD002", "PRD001"]

    def test_public_list_and_get(self, client, admin_auth, catalogue):
        client.post("/api/admin/collections", headers=admin_auth, json={"name": "Edit", "productIds": ["PRD001"]})
        assert [c["slug"] for c in client.get("/api/collections").json()["data"]] == ["edit"]
        for identifier in ("COL001", "edit"):
            assert client.get(f"/api/collections/{identifier}").json()["data"]["productIds"] == ["PRD001"]

    def test_missing(self, client):
        response = client.get("/api/collections/nope")
        assert response.status_code == 404 and response.json()["error_code"] == "COLLECTION_NOT_FOUND"

    def test_update_replaces_membership(self, client, admin_auth, catalogue):
        client.post("/api/admin/collections", headers=admin_auth, json={"name": "Edit", "productIds": ["PRD001"]})
        data = client.put("/api/admin/collections/COL001", headers=admin_auth,
                          json={"productIds": ["PRD003"], "description": None}).json()["data"]
        assert data["productIds"] == ["PRD003"] and data["description"] == "" and data["slug"] == "edit"

    def test_update_without_product_ids_keeps_them(self, client, admin_auth, catalogue):
        client.post("/api/admin/collections", headers=admin_auth, json={"name": "Edit", "productIds": ["PRD001"]})
        data = client.put("/api/admin/collections/COL001", headers=admin_auth, json={"name": "Renamed"}).json()["data"]
        assert data["productIds"] == ["PRD001"] and data["name"] == "Renamed"

    def test_name_required(self, client, admin_auth):
        response = client.post("/api/admin/collections", headers=admin_auth, json={})
        assert response.status_code == 422 and response.json()["error_code"] == "COLLECTION_INCOMPLETE"

    def test_a_duplicate_slug_is_a_conflict_not_a_crash(self, client, admin_auth):
        assert client.post("/api/admin/collections", headers=admin_auth, json={"name": "Edit"}).status_code == 201
        response = client.post("/api/admin/collections", headers=admin_auth, json={"name": "Edit"})
        assert response.status_code == 409
        assert response.json()["error_code"] == "DUPLICATE_RECORD"

    def test_delete_leaves_the_products(self, client, admin_auth, db, catalogue):
        client.post("/api/admin/collections", headers=admin_auth, json={"name": "Edit", "productIds": ["PRD001"]})
        assert client.delete("/api/admin/collections/COL001", headers=admin_auth).status_code == 200
        db.expire_all()
        assert db.get(Collection, "COL001") is None and db.get(Product, "PRD001") is not None

    def test_delete_missing(self, client, admin_auth):
        assert client.delete("/api/admin/collections/COL999", headers=admin_auth).status_code == 404


# --------------------------------------------------- admin tray and sidebar


class TestAdminNotifications:
    @pytest.fixture()
    def tray(self, db, admin, editor):
        now = datetime.utcnow()
        db.add_all([
            Notification(id="N1", kind="order", title="New order", body="", href="/admin/orders", read=False,
                         created_at=now - timedelta(minutes=2), admin_id=None),
            Notification(id="N2", kind="stock", title="Low stock", body="", href="", read=False,
                         created_at=now - timedelta(minutes=1), admin_id=admin.id),
            Notification(id="N3", kind="private", title="For the editor", body="", href="", read=False,
                         created_at=now, admin_id=editor.id),
        ])
        db.flush()

    def test_everyones_and_my_own_newest_first(self, client, admin_auth, tray):
        rows = client.get("/api/admin/notifications", headers=admin_auth).json()["data"]
        assert [r["id"] for r in rows] == ["N2", "N1"]
        assert set(rows[0]) == {"id", "kind", "title", "body", "href", "read", "at"}

    @staticmethod
    def _read(client, headers) -> dict:
        return {r["id"]: r["read"] for r in client.get("/api/admin/notifications", headers=headers).json()["data"]}

    def test_mark_one_read(self, client, admin_auth, db, tray):
        assert client.put("/api/admin/notifications/N1/read", headers=admin_auth).status_code == 200
        assert self._read(client, admin_auth)["N1"] is True

    def test_cannot_read_someone_elses(self, client, admin_auth, tray):
        response = client.put("/api/admin/notifications/N3/read", headers=admin_auth)
        assert response.status_code == 404 and response.json()["error_code"] == "NOTIFICATION_NOT_FOUND"

    def test_missing(self, client, admin_auth, tray):
        assert client.put("/api/admin/notifications/N999/read", headers=admin_auth).status_code == 404

    def test_mark_all_read_leaves_other_peoples(self, client, admin_auth, db, tray):
        from app.models import NotificationRead

        assert client.put("/api/admin/notifications/read-all", headers=admin_auth).status_code == 200
        assert self._read(client, admin_auth) == {"N1": True, "N2": True}
        # Read for this administrator only: the editor's own item, and everyone's for the editor, stay unread.
        db.expire_all()
        assert {r.notification_id for r in db.query(NotificationRead).filter_by(admin_id="ADM001")} == {"N1", "N2"}
        assert db.query(NotificationRead).filter_by(notification_id="N3").count() == 0


class TestAdminNavigation:
    @staticmethod
    def _tree(groups) -> dict:
        """{group heading: [label, or (folder label, [child labels])]}"""
        def row(item):
            if item.get("href"):
                return item["label"]
            return (item["label"], [row(child) for child in item["children"]])
        return {group["heading"]: [row(item) for item in group["items"]] for group in groups}

    @staticmethod
    def _hrefs(groups) -> list:
        out = []

        def walk(items):
            for item in items:
                if item.get("href"):
                    out.append(item["href"])
                walk(item.get("children") or [])

        for group in groups:
            walk(group["items"])
        return out

    def test_links_are_arranged_into_groups_and_folders(self, client, admin_auth, db):
        from app.models import SettingDocument

        db.add(SettingDocument(key="admin_navigation", value={"groups": [
            {"label": "Sales", "items": [{"href": "/admin/orders", "label": "Orders"},
                                         {"href": "/admin/customers", "label": "Customers"}]},
        ]}))
        db.flush()
        groups = client.get("/api/admin/navigation", headers=admin_auth).json()["data"]
        tree = self._tree(groups)
        assert tree["Sales"][:2] == ["Orders", ("Fulfilment", ["Packing", "Shipments", "Returns", "Delivery pincodes"])]
        assert ("Purchasing", ["Suppliers", "Purchase orders"]) in tree["Catalogue"]
        assert ("System", ["Audit log", "System health", "Backups"]) in tree["Administration"]
        assert tree["Customers"][0] == "Customers"
        # Every link appears exactly once, and each folder has an id and no href.
        hrefs = self._hrefs(groups)
        assert len(hrefs) == len(set(hrefs)) and "/admin/settings/couriers" in hrefs
        folders = [item for group in groups for item in group["items"] if not item["href"]]
        assert all(item["id"].endswith("-folder") and item["children"] for item in folders)

    def test_a_folder_of_one_is_just_a_link(self, client, admin_auth, db, monkeypatch):
        from app.models import SettingDocument
        from app.services import site

        # Store setup holds Couriers and Authentication; without Authentication it is a folder of one.
        monkeypatch.setattr(site, "ADDED_NAV_ITEMS",
                            [entry for entry in site.ADDED_NAV_ITEMS if entry[1]["id"] != "authentication"])
        db.add(SettingDocument(key="admin_navigation", value={"groups": [
            {"heading": "Admin", "items": [{"id": "users", "href": "/admin/admin-users", "label": "Admin users"}]},
        ]}))
        db.flush()
        groups = client.get("/api/admin/navigation", headers=admin_auth).json()["data"]
        admin = next(g for g in groups if g["heading"] == "Administration")
        # Payment webhooks etc. are added too, but Store setup has only Couriers: no folder for one link.
        assert "Couriers" in self._tree([admin])["Administration"]

    def test_saved_labels_and_badges_are_kept(self, client, admin_auth, db):
        from app.models import SettingDocument

        db.add(SettingDocument(key="admin_navigation", value={"groups": [
            {"heading": "Sales", "items": [{"id": "orders", "href": "/admin/orders", "label": "All orders",
                                            "icon": "orders", "badge": "openOrders"}]},
        ]}))
        db.flush()
        groups = client.get("/api/admin/navigation", headers=admin_auth).json()["data"]
        orders = next(i for g in groups for i in g["items"] if i.get("href") == "/admin/orders")
        assert orders["label"] == "All orders" and orders["badge"] == "openOrders"

    def test_a_link_the_layout_doesnt_know_stays_in_its_group(self, client, admin_auth, db):
        from app.models import SettingDocument

        db.add(SettingDocument(key="admin_navigation", value={"groups": [
            {"id": "nav_sales", "heading": "Sales", "items": [
                {"id": "orders", "href": "/admin/orders", "label": "Orders"},
                {"id": "custom", "href": "/admin/custom-report", "label": "Custom report"}]},
            {"id": "nav_extra", "heading": "Extras", "items": [
                {"id": "lab", "href": "/admin/lab", "label": "Lab"}]},
        ]}))
        db.flush()
        tree = self._tree(client.get("/api/admin/navigation", headers=admin_auth).json()["data"])
        assert tree["Sales"][-1] == "Custom report"
        assert tree["Extras"] == ["Lab"]

    def test_empty_sidebar(self, client, admin_auth):
        assert client.get("/api/admin/navigation", headers=admin_auth).json()["data"] == []

    def test_needs_an_admin(self, client, auth):
        assert client.get("/api/admin/navigation", headers=auth).status_code == 403


class TestReports:
    @pytest.mark.parametrize("range_key", ["7d", "30d", "rubbish"])
    def test_reports_for_a_range(self, client, admin_auth, catalogue, range_key):
        response = client.get("/api/admin/reports", headers=admin_auth, params={"range": range_key})
        assert response.status_code == 200 and response.json()["success"] is True

    def test_needs_an_admin(self, client, auth):
        assert client.get("/api/admin/reports", headers=auth).status_code == 403


class TestSignOut:
    def test_customer_logout_needs_nothing(self, client):
        assert client.post("/api/auth/logout").json() == {"success": True, "data": None, "message": "Signed out."}

    def test_admin_logout_is_recorded_in_the_audit_trail(self, client, admin_auth, db):
        from app.models import AuditLog

        assert client.post("/api/admin/auth/logout", headers=admin_auth).status_code == 200
        actions = [row.action for row in db.query(AuditLog).all()]
        assert "auth.logout" in actions

    def test_admin_logout_needs_an_admin(self, client, auth):
        assert client.post("/api/admin/auth/logout").status_code == 401
        assert client.post("/api/admin/auth/logout", headers=auth).status_code == 403
