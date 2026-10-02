"""
Shared helpers for the supplier and purchase-order tests (no tests of its own).

The GSTIN check character is computed here independently of the service, so a
test built on `gstin()` checks the service's algorithm rather than reusing it.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.core.security import create_access_token, hash_password

CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def check_char(first14: str) -> str:
    total = 0
    for position, char in enumerate(first14):
        value = CHARS.index(char)
        weighted = value * (1 if position % 2 == 0 else 2)
        total += (weighted // 36) + (weighted % 36)
    return CHARS[(36 - (total % 36)) % 36]


def gstin(state: str = "29", pan: str = "ABCDE1234F", entity: str = "1") -> str:
    first14 = f"{state}{pan}{entity}Z"
    return first14 + check_char(first14)


def wrong_check(value: str) -> str:
    """The same GSTIN with a different (so wrong) check character."""
    replacement = "A" if value[-1] != "A" else "B"
    return value[:-1] + replacement


_HASH = None


def role_headers(db, admin_id: str, role: str, permissions=None) -> dict:
    global _HASH
    from app.models import AdminUser

    if _HASH is None:
        _HASH = hash_password("Admin@123")
    db.add(AdminUser(id=admin_id, email=f"{admin_id.lower()}@example.com", password_hash=_HASH,
                     name=f"{role.title()} User", role=role, permissions=list(permissions or []), status="active",
                     created_at=datetime(2026, 1, 1)))
    db.flush()
    return {"Authorization": "Bearer " + create_access_token(admin_id, actor="admin", role=role)}


def supplier_payload(**overrides) -> dict:
    body = {
        "code": "ANVI-TEX", "name": "Anvi Textiles", "legalName": "Anvi Textiles Pvt Ltd",
        "contactPerson": "R. Kumar", "phone": "9876543210", "email": "sales@anvi.example.com",
        "website": "https://anvi.example.com", "gstin": gstin("29", "ABCDE1234F"), "pan": "ABCDE1234F",
        "businessType": "manufacturer", "taxTreatment": "registered",
        "billingAddress": {"line1": "12 Mill Road", "line2": "", "city": "Bengaluru", "state": "Karnataka",
                           "country": "India", "pincode": "560001"},
        "warehouseAddress": None, "paymentTerms": "Net 30", "creditDays": 30, "currency": "INR", "notes": "",
    }
    body.update(overrides)
    return body


def make_supplier(client, headers, **overrides) -> dict:
    response = client.post("/api/admin/suppliers", json=supplier_payload(**overrides), headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def link(client, headers, supplier_id: str, product_id: str, cost=450.0, **overrides) -> dict:
    body = {"productId": product_id, "supplierSku": f"SK-{product_id}", "purchaseCost": cost, "moq": 1,
            "leadTimeDays": 7, "status": "active", "preferred": False, "notes": ""}
    body.update(overrides)
    response = client.post(f"/api/admin/suppliers/{supplier_id}/products", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def make_po(client, headers, supplier_id: str, items, **overrides) -> dict:
    body = {"supplierId": supplier_id, "items": items}
    body.update(overrides)
    response = client.post("/api/admin/purchase-orders", json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["data"]


def advance(client, headers, po_id: str, *actions) -> dict:
    data = None
    for action in actions:
        response = client.post(f"/api/admin/purchase-orders/{po_id}/{action}", json={}, headers=headers)
        assert response.status_code == 200, response.text
        data = response.json()["data"]
    return data


def receive(client, headers, po_id: str, lines, key: str, **overrides):
    body = {"idempotencyKey": key, "items": lines}
    body.update(overrides)
    return client.post(f"/api/admin/purchase-orders/{po_id}/receipts", json=body, headers=headers)


@pytest.fixture()
def supplier(client, admin_auth, catalogue, settings_documents):
    """An active, GST-registered supplier in Karnataka (the store's own state)."""
    return make_supplier(client, admin_auth)


@pytest.fixture()
def sent_po(client, admin_auth, supplier):
    """A sent PO: 50 x PRD001 at 450 and 10 x PRD003 at 2000."""
    link(client, admin_auth, supplier["id"], "PRD001", cost=450.0, moq=10)
    link(client, admin_auth, supplier["id"], "PRD003", cost=2000.0)
    po = make_po(client, admin_auth, supplier["id"], [{"productId": "PRD001", "quantity": 50},
                                                       {"productId": "PRD003", "quantity": 10}])
    return advance(client, admin_auth, po["id"], "submit", "send")


def item_for(po: dict, product_id: str) -> dict:
    return next(item for item in po["items"] if item["productId"] == product_id)
