"""
The API's contract, checked on every route at once.

Generated from `app.routes`, so a route added tomorrow is covered without
anyone remembering to write its tests. For each route:

- **Who may call it.** A protected route refuses a missing token (401), a
  token of the wrong kind (403), and, for permission-gated admin routes, an
  administrator whose role grants nothing (403 PERMISSION_DENIED).
- **It never answers 500 to bad input.** Unknown ids in the path, empty and
  wrongly-typed bodies, and nonsense query parameters must all be refused (or
  ignored) as a client error. A 500 here is a bug: the server crashed on
  something a client sent.
- **Every refusal uses the envelope** `{success: false, message, error_code}`.

The tests talk to the real app and the test database. Side effects that would
reach outside it (backups, storage, email) are pointed at stubs, and the
network guard in conftest fails any test that tries to leave the machine.
"""

from __future__ import annotations

import typing
from datetime import datetime

import pytest
from fastapi.routing import APIRoute

from app.core import rate_limit
from app.core.config import settings
from app.core.security import create_access_token, hash_password
from app.main import app

pytestmark = pytest.mark.integration

# One bcrypt hash for every administrator in this file: hashing per test would
# cost a quarter of a second each, thousands of times.
_HASH = hash_password("Admin@123")


def _dependency_names(dependant) -> set:
    names = set()
    for dep in dependant.dependencies:
        names.add(getattr(dep.call, "__qualname__", str(dep.call)))
        names |= _dependency_names(dep)
    return names


def _kind(route: APIRoute) -> str:
    names = _dependency_names(route.dependant)
    if any(n.startswith(("require_permission", "require_access")) for n in names):
        return "admin-perm"
    if "get_current_admin" in names:
        return "admin"
    if "get_current_customer" in names:
        return "customer"
    return "public"


def _url(route: APIRoute) -> str:
    """The route's path with every parameter replaced by an id nothing has."""
    url = route.path
    for param in route.dependant.path_params:
        annotation = param.field_info.annotation
        value = "999999" if annotation in (int, typing.Optional[int]) else "NOPE999"
        url = url.replace("{" + param.name + "}", value)
    return url


ROUTES = [
    (method, route.path, _url(route), _kind(route))
    for route in app.routes
    if isinstance(route, APIRoute)
    for method in sorted(route.methods)
]
PROTECTED = [r for r in ROUTES if r[3] != "public"]
ADMIN = [r for r in ROUTES if r[3] in ("admin", "admin-perm")]
GATED = [r for r in ROUTES if r[3] == "admin-perm"]
CUSTOMER = [r for r in ROUTES if r[3] == "customer"]
WRITES = [r for r in ROUTES if r[0] in ("POST", "PUT", "PATCH", "DELETE")]
READS = [r for r in ROUTES if r[0] == "GET"]


def _id(row) -> str:
    return f"{row[0]} {row[1]}"


# ------------------------------------------------------------------ fixtures


@pytest.fixture(autouse=True)
def _contained(monkeypatch, tmp_path):
    """Keep anything a route might write inside the test: no real backups, no rate limits carried over."""
    from app.services import backups, storage

    rate_limit.reset()
    monkeypatch.setattr(settings, "BACKUP_LOCAL_DIR", str(tmp_path / "backups"))
    monkeypatch.setattr(settings, "BACKUP_STORAGE", "local")

    def fake_dump(connection, out):
        """A small but well-formed dump: one table, the closing line, and enough bytes to pass verification."""
        import os

        out.write("-- Table: contract\n-- " + os.urandom(4096).hex() + "\n")
        out.write(f"{backups.FOOTER} 1 tables, 0 rows\n")
        return 1, 0

    monkeypatch.setattr(backups, "_dump", fake_dump)

    class Bucket:
        def put_object(self, **kwargs):
            pass

        def generate_presigned_url(self, *args, **kwargs):
            return "https://signed.example/file"

    monkeypatch.setattr(storage, "_client", lambda *args: Bucket())
    yield
    rate_limit.reset()


def _admin(db, admin_id, role, permissions):
    from app.models import AdminUser

    user = AdminUser(id=admin_id, email=f"{admin_id.lower()}@example.com", password_hash=_HASH, name=f"{role} user",
                     role=role, permissions=permissions, status="active", created_at=datetime(2026, 1, 1))
    db.add(user)
    db.flush()
    return {"Authorization": "Bearer " + create_access_token(admin_id, actor="admin", role=role)}


@pytest.fixture()
def root(db):
    return _admin(db, "ADM900", "super-admin", [])


@pytest.fixture()
def nobody(db):
    """An administrator whose role is not in the role table and who holds no permissions."""
    return _admin(db, "ADM901", "no-such-role", [])


@pytest.fixture()
def shopper(db):
    from app.models import Customer

    db.add(Customer(id="CUS900", email="contract@example.com", password_hash=_HASH, first_name="Contract",
                    last_name="Test", phone="9876500900", status="active", joined_at=datetime(2026, 1, 1)))
    db.flush()
    return {"Authorization": "Bearer " + create_access_token("CUS900", actor="customer")}


def _call(client, method, url, headers=None, **kwargs):
    return client.request(method, url, headers=headers or {}, **kwargs)


def _assert_error_envelope(response):
    if "application/json" not in response.headers.get("content-type", ""):
        return
    body = response.json()
    assert body.get("success") is False, body
    assert isinstance(body.get("message"), str) and body["message"], body
    assert isinstance(body.get("error_code"), str) and body["error_code"], body


def _assert_not_a_crash(response, row):
    assert response.status_code < 500, f"{_id(row)} answered {response.status_code}: {response.text[:400]}"
    if response.status_code >= 400:
        _assert_error_envelope(response)


# --------------------------------------------------------------- inventory


class TestInventory:
    def test_the_routes_are_all_found(self):
        """A guard on the generator itself: if it finds nothing, every test below passes vacuously."""
        assert len(ROUTES) > 300
        assert len(PROTECTED) > 250 and len(GATED) > 100 and len(CUSTOMER) > 50

    def test_only_sign_in_and_signed_downloads_are_public_under_admin(self):
        public_admin = sorted(path for method, path, url, kind in ROUTES if kind == "public" and "/admin/" in path)
        assert public_admin == ["/api/admin/auth/login", "/api/admin/backups/{backup_id}/file"]


# ------------------------------------------------------------------- tokens


@pytest.mark.parametrize("row", PROTECTED, ids=_id)
def test_a_protected_route_refuses_a_missing_token(client, row):
    method, _, url, _ = row
    response = _call(client, method, url)
    assert response.status_code == 401, response.text[:300]
    _assert_error_envelope(response)
    assert response.json()["error_code"] == "UNAUTHENTICATED"


@pytest.mark.parametrize("row", PROTECTED, ids=_id)
def test_a_protected_route_refuses_a_forged_token(client, row):
    method, _, url, _ = row
    response = _call(client, method, url, {"Authorization": "Bearer not.a.real-token"})
    assert response.status_code == 401
    assert response.json()["error_code"] == "TOKEN_INVALID"


@pytest.mark.parametrize("row", ADMIN, ids=_id)
def test_an_admin_route_refuses_a_customer_token(client, shopper, row):
    method, _, url, _ = row
    response = _call(client, method, url, shopper)
    assert response.status_code == 403, response.text[:300]
    _assert_error_envelope(response)


@pytest.mark.parametrize("row", CUSTOMER, ids=_id)
def test_a_customer_route_refuses_an_admin_token(client, root, row):
    method, _, url, _ = row
    response = _call(client, method, url, root)
    assert response.status_code == 403, response.text[:300]
    _assert_error_envelope(response)


@pytest.mark.parametrize("row", GATED, ids=_id)
def test_a_gated_admin_route_refuses_a_role_without_the_permission(client, nobody, row):
    method, _, url, _ = row
    response = _call(client, method, url, nobody)
    assert response.status_code == 403, response.text[:300]
    assert response.json()["error_code"] == "PERMISSION_DENIED"


# ----------------------------------------------------------- unknown records


def _headers_for(kind, root, shopper):
    return root if kind in ("admin", "admin-perm") else shopper if kind == "customer" else {}


@pytest.mark.parametrize("row", [r for r in ROUTES if "{" in r[1]], ids=_id)
def test_an_unknown_id_in_the_path_is_never_a_crash(client, root, shopper, row):
    method, _, url, kind = row
    kwargs = {"json": {}} if method in ("POST", "PUT", "PATCH") else {}
    response = _call(client, method, url, _headers_for(kind, root, shopper), **kwargs)
    _assert_not_a_crash(response, row)


# --------------------------------------------------------------- bad bodies


GARBAGE_BODIES = {
    "empty-object": {},
    "a-list": [1, "two", None],
    "a-string": "just text",
    "wrong-types": {
        "name": 123, "title": ["x"], "status": {"nested": True}, "email": 42, "amount": "lots", "quantity": "two",
        "price": "free", "code": 7, "productId": None, "id": {}, "reason": 5, "enabled": "maybe", "items": "none",
        "page": "first", "date": "yesterday", "from": "soon", "to": [], "value": {"a": 1}, "payload": 3.5,
    },
}


@pytest.mark.parametrize("shape", sorted(GARBAGE_BODIES))
@pytest.mark.parametrize("row", WRITES, ids=_id)
def test_a_malformed_body_is_never_a_crash(client, root, shopper, row, shape):
    method, _, url, kind = row
    response = _call(client, method, url, _headers_for(kind, root, shopper), json=GARBAGE_BODIES[shape])
    _assert_not_a_crash(response, row)


@pytest.mark.parametrize("row", WRITES, ids=_id)
def test_a_body_that_is_not_json_is_never_a_crash(client, root, shopper, row):
    method, _, url, kind = row
    headers = {**_headers_for(kind, root, shopper), "Content-Type": "application/json"}
    response = _call(client, method, url, headers, content=b"{this is not json")
    _assert_not_a_crash(response, row)


# ------------------------------------------------------------ bad query strings


BAD_QUERY = {
    "page": "-1", "pageSize": "100000", "page_size": "0", "limit": "-5", "sort": "nonsense;DROP TABLE",
    "status": "<script>", "q": "%' OR 1=1 --", "search": "\u0000‮", "from": "not-a-date", "to": "2026-13-45",
    "days": "-3", "range": "forever", "productId": "", "category": "../../etc", "minPrice": "cheap",
    "maxPrice": "-1", "inStockOnly": "perhaps", "withCounts": "2",
}


@pytest.mark.parametrize("row", READS, ids=_id)
def test_nonsense_query_parameters_are_never_a_crash(client, root, shopper, row):
    method, _, url, kind = row
    response = _call(client, method, url, _headers_for(kind, root, shopper), params=BAD_QUERY)
    _assert_not_a_crash(response, row)


@pytest.mark.parametrize("row", READS, ids=_id)
def test_a_plain_read_on_an_empty_store_is_never_a_crash(client, root, shopper, row):
    """A fresh installation has no products, orders or settings documents; nothing should fall over."""
    method, _, url, kind = row
    response = _call(client, method, url, _headers_for(kind, root, shopper))
    _assert_not_a_crash(response, row)
