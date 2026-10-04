"""
The segments API: default segments, the field registry, preview, create/edit,
recalculation and history, archive/restore, members and masking, CSV export
and its audit trail, RFM settings, summary, and who may do what.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta

import pytest
from sqlalchemy import select

from app.models import AuditLog
from app.models.segments import Segment, SegmentEvent
from app.services.segments import metrics, service
from tests.integration.segments_helpers import order, person, segment_payload
from tests.integration.test_suppliers_helpers import role_headers

pytestmark = pytest.mark.integration

API = "/api/admin/segments"


@pytest.fixture()
def shoppers(db, catalogue):
    """Three customers with known figures, metrics refreshed."""
    person(db, "CUS701", city="Bengaluru", first="Asha", phone="9876500701")
    person(db, "CUS702", city="Pune", first="Ravi")
    person(db, "CUS703", joined_days_ago=3, first="Meera")
    order(db, "CUS701", 6000, days_ago=5)
    order(db, "CUS701", 6000, days_ago=40)
    order(db, "CUS702", 800, days_ago=200)
    metrics.refresh(db, ["CUS701", "CUS702", "CUS703"])
    return ["CUS701", "CUS702", "CUS703"]


@pytest.fixture()
def manager(db):
    return role_headers(db, "ADM031", "manager")


def create(client, headers, **overrides):
    response = client.post(API, json=segment_payload(**overrides), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def preview(client, headers, rules, match="all", **extra):
    return client.post(f"{API}/preview", json={"match": match, "rules": rules, **extra}, headers=headers)


class TestDefaults:
    def test_seeded_on_first_read_and_only_once(self, client, admin_auth, db):
        body = client.get(f"{API}?pageSize=100", headers=admin_auth).json()["data"]
        slugs = {item["slug"] for item in body["items"]}
        assert slugs == {d[0] for d in service.DEFAULTS} and body["counts"]["active"] == 15
        assert all(item["kind"] == "default" for item in body["items"])
        assert service.ensure_defaults(db) == 0
        assert client.get(f"{API}?pageSize=100", headers=admin_auth).json()["data"]["pagination"]["total"] == 15

    def test_defaults_are_editable_and_archivable_and_never_recreated(self, client, admin_auth, db):
        client.get(API, headers=admin_auth)
        vip = db.execute(select(Segment).where(Segment.slug == "vip")).scalar_one()
        response = client.put(f"{API}/{vip.id}", json={"rules": [{"field": "totalSpend", "operator": "gte",
                                                                    "value": 50000}]}, headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["rules"][0]["value"] == 50000
        assert client.post(f"{API}/{vip.id}/archive", headers=admin_auth).json()["data"]["status"] == "archived"
        assert service.ensure_defaults(db) == 0
        assert db.execute(select(Segment).where(Segment.slug == "vip")).scalar_one().status == "archived"

    def test_every_default_rule_is_valid(self):
        for slug, _name, _desc, match, rule_list in service.DEFAULTS:
            from app.services.segments import rules

            assert rules.clean(match, rule_list)[1], slug


class TestRegistryAndPreview:
    def test_fields_include_database_options(self, client, admin_auth, catalogue):
        data = client.get(f"{API}/fields", headers=admin_auth).json()["data"]
        by_key = {f["key"]: f for f in data["fields"]}
        assert {"value": "CAT001", "label": "Women"} in by_key["purchasedCategories"]["options"]
        assert by_key["totalSpend"]["type"] == "money" and "between" in by_key["totalSpend"]["operators"]
        assert data["limits"]["maxConditions"] == 30

    def test_preview_counts_and_lists_without_saving(self, client, admin_auth, shoppers, db):
        response = preview(client, admin_auth, [{"field": "totalSpend", "operator": "gte", "value": 1000}])
        data = response.json()["data"]
        assert response.status_code == 200 and data["count"] == 1
        assert data["items"][0]["customerId"] == "CUS701" and data["items"][0]["totalSpend"] == 12000.0
        assert data["items"][0]["email"] == "cus701@example.com" and data["masked"] is False
        assert db.execute(select(Segment).where(Segment.kind == "custom")).first() is None

    def test_preview_masks_contacts_without_export_permission(self, client, manager, shoppers):
        data = preview(client, manager, [{"field": "city", "operator": "equals", "value": "Bengaluru"}]).json()["data"]
        assert data["masked"] is True
        assert data["items"][0]["email"] == "c••••@example.com" and "•" in data["items"][0]["phone"]

    def test_any_all_and_a_group(self, client, admin_auth, shoppers):
        rules = [{"field": "totalOrders", "operator": "gte", "value": 1},
                 {"match": "any", "rules": [{"field": "city", "operator": "equals", "value": "Pune"},
                                            {"field": "lastOrderAt", "operator": "within-last-days", "value": 10}]}]
        assert preview(client, admin_auth, rules).json()["data"]["count"] == 2
        assert preview(client, admin_auth, rules[:1] + rules[1]["rules"][:1]).json()["data"]["count"] == 1
        assert preview(client, admin_auth, rules[1]["rules"], match="any").json()["data"]["count"] == 2
        assert preview(client, admin_auth, []).json()["data"]["count"] >= 3

    def test_dates_between_and_not_within(self, client, admin_auth, shoppers):
        today = datetime.utcnow().date()
        between = [(today - timedelta(days=45)).isoformat(), (today - timedelta(days=4)).isoformat()]
        assert preview(client, admin_auth, [{"field": "lastOrderAt", "operator": "between", "value": between}]
                       ).json()["data"]["count"] == 1
        never = preview(client, admin_auth, [{"field": "lastOrderAt", "operator": "not-within-last-days", "value": 90}])
        ids = {i["customerId"] for i in never.json()["data"]["items"]}
        assert {"CUS702", "CUS703"} <= ids and "CUS701" not in ids
        joined = preview(client, admin_auth, [{"field": "joinedAt", "operator": "within-last-days", "value": 7}])
        assert [i["customerId"] for i in joined.json()["data"]["items"]] == ["CUS703"]

    def test_bad_rules_name_the_problem(self, client, admin_auth):
        response = preview(client, admin_auth, [{"field": "totalSpend", "operator": "between", "value": [9, 1]}])
        body = response.json()
        assert response.status_code == 422 and body["error_code"] == "INVALID_SEGMENT_RULE"
        assert body["details"]["path"] == "rules.0" and "Total spend" in body["message"]

    def test_page_size_is_capped(self, client, admin_auth, shoppers):
        data = preview(client, admin_auth, [], pageSize=500).json()["data"]
        assert data["pageSize"] == 10


class TestLifecycle:
    def test_create_calculates_members_and_history(self, client, admin_auth, shoppers, db):
        data = create(client, admin_auth)
        assert data["memberCount"] == 1 and data["kind"] == "custom" and data["slug"] == "big-spenders"
        assert data["lastCalculatedAt"] and data["actions"]["export"] is True
        assert [h["action"] for h in data["history"]] == ["created"]
        labels = {entry["key"]: entry["count"] for entry in data["rfm"]["labels"]}
        assert sum(labels.values()) == 1

    def test_names_are_unique_and_validated(self, client, admin_auth):
        create(client, admin_auth, name="Pune")
        clash = client.post(API, json=segment_payload(name="pune"), headers=admin_auth)
        assert clash.status_code == 409 and clash.json()["error_code"] == "SEGMENT_NAME_TAKEN"
        assert client.post(API, json=segment_payload(name="x"), headers=admin_auth).status_code == 422
        assert client.post(API, json=["not", "an", "object"], headers=admin_auth).status_code == 422

    def test_changing_rules_records_before_and_after_and_recalculates(self, client, admin_auth, shoppers):
        seg = create(client, admin_auth)
        response = client.put(f"{API}/{seg['id']}", json={"rules": [
            {"field": "totalOrders", "operator": "gte", "value": 1}]}, headers=admin_auth)
        data = response.json()["data"]
        assert data["memberCount"] == 2
        changed = next(h for h in data["history"] if h["action"] == "rules-changed")
        assert changed["details"]["before"]["rules"][0]["field"] == "totalSpend"
        assert changed["details"]["after"]["rules"][0]["field"] == "totalOrders"
        renamed = client.put(f"{API}/{seg['id']}", json={"name": "Buyers"}, headers=admin_auth).json()["data"]
        assert renamed["history"][0]["action"] == "updated" and renamed["memberCount"] == 2

    def test_recalculate_reports_counts_and_records_them(self, client, admin_auth, shoppers, db):
        seg = create(client, admin_auth, rules=[{"field": "totalOrders", "operator": "gte", "value": 1}])
        order(db, "CUS703", 100)
        metrics.refresh(db, ["CUS703"])
        response = client.post(f"{API}/{seg['id']}/recalculate", headers=admin_auth)
        assert response.status_code == 200 and response.json()["message"] == "Recalculated: 2 → 3 customers."
        event = response.json()["data"]["history"][0]
        assert event["action"] == "recalculated" and event["details"]["before"] == 2 and event["details"]["after"] == 3

    def test_automatic_recalculation_records_only_changes(self, client, admin_auth, shoppers, db):
        seg = create(client, admin_auth)
        row = db.get(Segment, seg["id"])
        service.recalculate(db, row)
        assert db.execute(select(SegmentEvent).where(SegmentEvent.segment_id == row.id,
                                                     SegmentEvent.action == "recalculated")).first() is None

    def test_a_subset_recalculation_touches_only_those_customers(self, client, admin_auth, shoppers, db):
        seg = create(client, admin_auth, rules=[{"field": "totalOrders", "operator": "gte", "value": 1}])
        row = db.get(Segment, seg["id"])
        order(db, "CUS703", 100)
        metrics.refresh(db, ["CUS703"])
        assert service.recalculate(db, row, customer_ids=["CUS703"]) == {"before": 2, "after": 3}
        assert service.recalculate(db, row, customer_ids=[]) == {"before": 3, "after": 3}

    def test_archive_restore_and_the_list_filters(self, client, admin_auth, shoppers):
        seg = create(client, admin_auth)
        archived = client.post(f"{API}/{seg['id']}/archive", headers=admin_auth).json()["data"]
        assert archived["status"] == "archived" and archived["actions"]["restore"] is True
        assert client.put(f"{API}/{seg['id']}", json={"name": "Nope"}, headers=admin_auth).status_code == 409
        assert client.post(f"{API}/{seg['id']}/recalculate", headers=admin_auth).status_code == 409
        listed = client.get(f"{API}?status=archived", headers=admin_auth).json()["data"]
        assert [i["id"] for i in listed["items"]] == [seg["id"]] and listed["counts"]["archived"] == 1
        by_id = client.get(f"{API}?status=all&kind=custom&q={seg['id']}", headers=admin_auth).json()["data"]
        assert [i["id"] for i in by_id["items"]] == [seg["id"]]
        restored = client.post(f"{API}/{seg['id']}/restore", headers=admin_auth).json()["data"]
        assert restored["status"] == "active" and restored["history"][0]["action"] in ("restored", "recalculated")

    def test_the_list_box_takes_a_segment_id_exactly(self, client, admin_auth, db):
        """docs/id-lookup.md: a Segment ID, exactly; names, descriptions, prefixes and junk find nothing."""
        seg = create(client, admin_auth)
        longer_id = int(f"{seg['id']}1")
        now = datetime.utcnow()
        db.add(Segment(id=longer_id, name="Longer id", slug=f"longer-id-{longer_id}", rules=[], created_at=now,
                       updated_at=now))
        db.flush()

        def ids(q):
            response = client.get(API, params={"status": "all", "q": q}, headers=admin_auth)
            assert response.status_code == 200, response.text
            return [i["id"] for i in response.json()["data"]["items"]]

        assert ids(str(seg["id"])) == [seg["id"]]  # never the longer ID it is a prefix of
        assert ids(str(longer_id)) == [longer_id]
        for text in (seg["name"], seg["name"][:4], "spend", "'; DROP TABLE segments; --", "a@b.com"):
            assert ids(text) == []

    def test_unknown_segment(self, client, admin_auth):
        assert client.get(f"{API}/99999", headers=admin_auth).json()["error_code"] == "SEGMENT_NOT_FOUND"


class TestMembersAndExport:
    def test_members_paginate_search_and_mask(self, client, admin_auth, manager, shoppers):
        seg = create(client, admin_auth, rules=[])
        page = client.get(f"{API}/{seg['id']}/members?pageSize=2", headers=admin_auth).json()["data"]
        assert page["pagination"]["total"] >= 3 and len(page["items"]) == 2
        for text in ("Meera", "CUS70", "cus703@example.com", "'; DROP TABLE customers; --"):
            response = client.get(f"{API}/{seg['id']}/members", params={"q": text}, headers=manager)
            assert response.status_code == 200 and response.json()["data"]["items"] == []
        found = client.get(f"{API}/{seg['id']}/members?q=CUS703", headers=manager).json()["data"]
        assert [i["customerId"] for i in found["items"]] == ["CUS703"] and found["masked"] is True
        assert "@" in found["items"][0]["email"] and "cus703" not in found["items"][0]["email"]

    def test_export_is_unmasked_audited_and_recorded(self, client, admin_auth, shoppers, db):
        seg = create(client, admin_auth, rules=[{"field": "totalOrders", "operator": "gte", "value": 1}])
        response = client.get(f"{API}/{seg['id']}/export", headers=admin_auth)
        assert response.status_code == 200 and response.headers["content-type"].startswith("text/csv")
        assert "attachment" in response.headers["content-disposition"]
        rows = list(csv.reader(io.StringIO(response.text.lstrip("﻿"))))
        assert rows[0][:4] == ["Customer ID", "First name", "Last name", "Email"]
        assert [r[0] for r in rows[1:]] == ["CUS701", "CUS702"] and rows[1][3] == "cus701@example.com"
        assert rows[1][10] == "12000.00"
        audit = db.execute(select(AuditLog).where(AuditLog.action == "segment.export")).scalar_one()
        assert audit.details == {"rows": 2}
        detail = client.get(f"{API}/{seg['id']}", headers=admin_auth).json()["data"]
        assert detail["history"][0]["action"] == "exported" and detail["history"][0]["details"]["rows"] == 2

    def test_export_neutralises_spreadsheet_formulas(self, client, admin_auth, db, catalogue):
        person(db, "CUS790", first="=HYPERLINK(1)")
        metrics.refresh(db, ["CUS790"])
        seg = create(client, admin_auth, rules=[{"field": "name", "operator": "starts-with", "value": "=HYPER"}])
        text = client.get(f"{API}/{seg['id']}/export", headers=admin_auth).text
        assert "'=HYPERLINK(1)" in text

    def test_export_needs_segments_export(self, client, manager, admin_auth, shoppers):
        seg = create(client, admin_auth)
        refused = client.get(f"{API}/{seg['id']}/export", headers=manager)
        assert refused.status_code == 403
        assert client.get(f"{API}/{seg['id']}", headers=manager).json()["data"]["actions"]["export"] is False


class TestSettingsAndSummary:
    def test_settings_round_trip_and_validation(self, client, admin_auth, shoppers):
        data = client.get(f"{API}/settings", headers=admin_auth).json()["data"]
        assert data["settings"]["recencyDays"] == [30, 60, 90, 180] and data["status"]["metrics"] >= 3
        changed = {**data["settings"], "frequencyOrders": [3, 4, 6, 9]}
        response = client.put(f"{API}/settings", json=changed, headers=admin_auth)
        assert response.status_code == 200 and response.json()["data"]["settings"]["frequencyOrders"] == [3, 4, 6, 9]
        bad = client.put(f"{API}/settings", json={**changed, "recencyDays": [9, 1, 2, 3]}, headers=admin_auth)
        assert bad.status_code == 422 and bad.json()["error_code"] == "INVALID_SEGMENT_SETTINGS"

    def test_refresh_everything_and_summary(self, client, admin_auth, shoppers):
        result = client.post(f"{API}/metrics/refresh", headers=admin_auth).json()["data"]
        assert result["refreshed"] >= 3 and result["segments"] == 15
        summary = client.get(f"{API}/summary", headers=admin_auth).json()["data"]
        assert summary["totalCustomers"] >= 3 and summary["newCustomers30d"] >= 1
        assert summary["returningCustomers"] >= 1 and summary["activeSegments"] == 15
        assert set(summary) == {"totalCustomers", "newCustomers30d", "returningCustomers", "vip", "atRisk",
                                "activeSegments", "oldestRefreshAt"}


class TestPermissions:
    @pytest.mark.parametrize("path", ["", "/fields", "/settings", "/summary"])
    def test_customers_and_signed_out_are_refused(self, client, auth, path):
        assert client.get(f"{API}{path}", headers=auth).status_code == 403
        assert client.get(f"{API}{path}").status_code == 401

    def test_editor_and_staff_are_refused(self, client, db, editor):
        from app.core.security import create_access_token

        editor_headers = {"Authorization": "Bearer " + create_access_token(editor.id, actor="admin", role="editor")}
        staff = role_headers(db, "ADM032", "staff")
        for headers in (editor_headers, staff):
            assert client.get(API, headers=headers).status_code == 403
            assert client.post(API, json=segment_payload(), headers=headers).status_code == 403

    def test_manager_can_build_but_not_export(self, client, manager, shoppers):
        seg = client.post(API, json=segment_payload(), headers=manager)
        assert seg.status_code == 201
        assert client.get(f"{API}/{seg.json()['data']['id']}/export", headers=manager).status_code == 403
