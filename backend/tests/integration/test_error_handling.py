"""
What a client is told when something goes wrong.

The handlers are installed on a small app of their own with one route per
failure, so each can be provoked on demand. Nothing is added to the real
application. The real app is then checked for the cases it produces on its own:
an unknown route, a wrong method, a malformed body, and the health checks.

The rule under test: **the client gets something it can act on, and nothing
else.** No driver message, table name or stack trace in any response.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError

from app.core import errors
from app.core.errors import register_error_handlers

pytestmark = pytest.mark.integration

SECRET = "table customers column password_hash"


class Body(BaseModel):
    name: str
    count: int


@pytest.fixture()
def probe():
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/app-error/{kind}")
    def app_error(kind: str):
        cls = {
            "bad": errors.AppError, "missing": errors.NotFoundError, "conflict": errors.ConflictError,
            "invalid": errors.ValidationError, "unauth": errors.AuthenticationError,
            "forbidden": errors.AuthorizationError, "rule": errors.BusinessRuleError,
            "limited": errors.RateLimitedError,
        }[kind]
        raise cls("readable message", details={"field": "x"} if kind == "invalid" else None)

    @app.get("/custom-code")
    def custom_code():
        raise errors.NotFoundError("no order", error_code="ORDER_NOT_FOUND")

    @app.post("/body")
    def body(payload: Body):
        return payload

    @app.get("/integrity")
    def integrity():
        raise IntegrityError("INSERT", {}, Exception(f"Duplicate entry for {SECRET}"))

    @app.get("/unreachable")
    def unreachable():
        raise OperationalError("SELECT", {}, Exception(f"Can't connect: {SECRET}"))

    @app.get("/timeout")
    def timeout():
        raise TimeoutError(SECRET)

    @app.get("/sql")
    def sql():
        raise ProgrammingError("SELECT", {}, Exception(f"Unknown column {SECRET}"))

    @app.get("/crash")
    def crash():
        raise RuntimeError(SECRET)

    return TestClient(app, raise_server_exceptions=False)


class TestAppErrors:
    @pytest.mark.parametrize("kind, status, code", [
        ("bad", 400, "BAD_REQUEST"), ("missing", 404, "NOT_FOUND"), ("conflict", 409, "CONFLICT"),
        ("invalid", 422, "VALIDATION_ERROR"), ("unauth", 401, "UNAUTHENTICATED"),
        ("forbidden", 403, "FORBIDDEN"), ("rule", 422, "BUSINESS_RULE_VIOLATION"),
        ("limited", 429, "RATE_LIMITED"),
    ])
    def test_status_and_envelope(self, probe, kind, status, code):
        response = probe.get(f"/app-error/{kind}")
        assert response.status_code == status
        body = response.json()
        assert body["success"] is False
        assert body["message"] == "readable message"
        assert body["error_code"] == code

    def test_details_appear_only_when_given(self, probe):
        assert probe.get("/app-error/invalid").json()["details"] == {"field": "x"}
        assert "details" not in probe.get("/app-error/missing").json()

    def test_instance_error_code(self, probe):
        assert probe.get("/custom-code").json()["error_code"] == "ORDER_NOT_FOUND"


class TestRequestValidation:
    def test_missing_fields_are_listed_by_name(self, probe):
        response = probe.post("/body", json={})
        assert response.status_code == 422
        body = response.json()
        assert body["error_code"] == "VALIDATION_ERROR"
        assert body["message"] == "The request could not be validated."
        assert {d["field"] for d in body["details"]} == {"name", "count"}
        assert all(d["message"] for d in body["details"])

    def test_wrong_type(self, probe):
        details = probe.post("/body", json={"name": "a", "count": "many"}).json()["details"]
        assert [d["field"] for d in details] == ["count"]

    def test_body_that_is_not_json(self, probe):
        response = probe.post("/body", content=b"{not json", headers={"Content-Type": "application/json"})
        assert response.status_code == 422
        assert response.json()["details"]  # a field-less error still names where


class TestDatabaseErrors:
    def test_integrity_error_is_a_409_without_the_schema(self, probe):
        response = probe.get("/integrity")
        assert response.status_code == 409
        assert response.json()["error_code"] == "DUPLICATE_RECORD"
        assert SECRET not in response.text

    @pytest.mark.parametrize("path", ["/unreachable"])
    def test_unreachable_database_is_a_503_inviting_a_retry(self, probe, path):
        response = probe.get(path)
        assert response.status_code == 503
        assert response.json()["error_code"] == "SERVICE_UNAVAILABLE"
        assert SECRET not in response.text

    def test_other_database_errors_are_a_500(self, probe):
        response = probe.get("/sql")
        assert response.status_code == 500
        assert response.json()["error_code"] == "DATABASE_ERROR"
        assert SECRET not in response.text


class TestUnhandled:
    @pytest.mark.parametrize("path", ["/crash", "/timeout"])
    def test_anything_else_is_a_generic_500(self, probe, path):
        response = probe.get(path)
        assert response.status_code == 500
        body = response.json()
        assert body == {"success": False, "message": body["message"], "error_code": "INTERNAL_ERROR"}
        assert SECRET not in response.text
        assert "Traceback" not in response.text


class TestTheRealApp:
    def test_unknown_route_is_a_404_envelope(self, client):
        response = client.get("/api/this-does-not-exist")
        assert response.status_code == 404
        assert response.json()["error_code"] == "NOT_FOUND"
        assert response.json()["success"] is False

    def test_wrong_method_is_a_405_envelope(self, client):
        response = client.delete("/api/auth/login")
        assert response.status_code == 405
        assert response.json()["error_code"] == "METHOD_NOT_ALLOWED"

    def test_malformed_body_on_a_real_endpoint(self, client):
        response = client.post("/api/auth/login", json={"email": "not-an-email"})
        assert response.status_code == 422
        fields = {d["field"] for d in response.json()["details"]}
        assert {"email", "password"} <= fields

    def test_invalid_path_parameter_type(self, client, catalogue):
        # page must be >= 1
        response = client.get("/api/products", params={"page": 0})
        assert response.status_code == 422

    def test_a_database_failure_inside_a_real_route_hides_the_driver_message(self, client, db, monkeypatch,
                                                                              catalogue):
        """Make the request's session fail, as a lost connection would."""

        def broken(*args, **kwargs):
            raise OperationalError("SELECT", {}, Exception(f"Lost connection: {SECRET}"))

        monkeypatch.setattr(db, "execute", broken)
        monkeypatch.setattr(db, "scalars", broken)
        monkeypatch.setattr(db, "scalar", broken)
        response = client.get("/api/products")
        assert response.status_code == 503
        assert SECRET not in response.text


class TestHealth:
    def test_liveness_has_no_dependencies(self, client):
        response = client.get("/health/live")
        assert response.status_code == 200
        assert response.json()["success"] is True

    def test_readiness_answers_with_statuses_only(self, client):
        response = client.get("/health/ready")
        assert response.status_code in (200, 503)
        body = response.json()
        assert "data" in body and isinstance(body["success"], bool)
        assert "password" not in response.text.lower()

    def test_health_reports_the_database(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()["data"]
        assert data["database"] in ("ok", "unreachable")
        assert data["status"] in ("ok", "degraded")

    def test_health_when_the_database_is_unreachable(self, client, monkeypatch):
        from app.core import database

        class Down:
            def connect(self):
                raise OperationalError("SELECT 1", {}, Exception("refused"))

        monkeypatch.setattr(database, "engine", Down())
        body = client.get("/health").json()
        assert body["success"] is False
        assert body["data"] == {"status": "degraded", "database": "unreachable",
                                "environment": body["data"]["environment"]}
        assert "refused" not in str(body)
