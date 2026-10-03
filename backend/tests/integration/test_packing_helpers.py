"""
Shared helpers for the packing and label tests (no tests of its own).

An order is placed through the API (cash on delivery: confirmed at once),
its packing job read through the queue, and walked through picking and
packing with the same calls the portal makes.
"""

from __future__ import annotations

import pytest

from tests.integration.test_shipping_helpers import place_order

BASE = "/api/admin/packing"
BOX = {"weightGrams": 800, "lengthCm": 30, "widthCm": 20, "heightCm": 5, "type": "box"}


def job_for(client, headers, order_id: str) -> dict:
    card = client.get(f"/api/admin/orders/{order_id}/packing", headers=headers)
    assert card.status_code == 200, card.text
    job = card.json()["data"]["job"]
    assert job is not None
    return detail(client, headers, job["id"])


def detail(client, headers, job_id: int) -> dict:
    response = client.get(f"{BASE}/{job_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def call(client, headers, method: str, path: str, body=None, expect: int = 200) -> dict:
    response = client.request(method, f"{BASE}{path}", headers=headers, json=body)
    assert response.status_code == expect, response.text
    return response.json()


def picked(client, headers, job: dict) -> dict:
    call(client, headers, "POST", f"/{job['id']}/pick-all")
    return call(client, headers, "POST", f"/{job['id']}/complete-picking")["data"]


def packed(client, headers, job: dict, packages=None) -> dict:
    """Pick everything, put it in one box (or the given packages), mark it packed."""
    data = picked(client, headers, job)
    for body in packages or [dict(BOX)]:
        data = call(client, headers, "POST", f"/{job['id']}/packages", body, expect=201)["data"]
    return call(client, headers, "POST", f"/{job['id']}/packed", {})["data"]


@pytest.fixture()
def packing_order(client, auth, catalogue, settings_documents) -> dict:
    """A confirmed cash-on-delivery order for two kurtas and one shirt."""
    client.post("/api/cart/items", headers=auth, json={"productId": "PRD002", "quantity": 1})
    return place_order(client, auth, quantity=2)
