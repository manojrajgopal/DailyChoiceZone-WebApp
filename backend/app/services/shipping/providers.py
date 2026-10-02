"""
Courier configuration: one row per adapter, credentials sealed and write-only.

Reading returns only *which* credential fields are set, masked. A blank or
omitted credential on save keeps what is stored. Exactly one provider is the
default; activating one needs its required credentials.
"""

from __future__ import annotations

import copy
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings as app_settings
from app.core.errors import NotFoundError, ValidationError
from app.models.shipping import ShippingProvider as ProviderRow
from app.services import audit
from app.services.email import crypto
from app.services.shipping import registry
from app.services.shipping.base import ProviderError

BULLET = "•"
PINCODE = re.compile(r"^[1-9][0-9]{5}$")

DEFAULT_SETTINGS = {
    "defaultService": "",
    "services": [],
    "pickupLocation": "",
    "origin": {"name": "", "phone": "", "line1": "", "line2": "", "city": "", "state": "", "pincode": ""},
    "checkoutServiceability": False,
    "defaultPackage": None,
}
ORIGIN_FIELDS = ("name", "phone", "line1", "line2", "city", "state", "pincode")


def mask_credential(key: str, value: str) -> str:
    value = str(value or "")
    if not value:
        return ""
    if key == "email" and "@" in value:
        local, _, domain = value.partition("@")
        return f"{local[:1]}{BULLET * 4}@{domain}"
    if key == "password":
        return BULLET * 8
    return BULLET * 4 + value[-4:]


def settings_of(row: Optional[ProviderRow]) -> dict:
    merged = copy.deepcopy(DEFAULT_SETTINGS)
    stored = (row.settings if row is not None else None) or {}
    if isinstance(stored, dict):
        for key in DEFAULT_SETTINGS:
            if key in stored:
                merged[key] = copy.deepcopy(stored[key])
    origin = merged.get("origin") if isinstance(merged.get("origin"), dict) else {}
    merged["origin"] = {field: str(origin.get(field) or "") for field in ORIGIN_FIELDS}
    return merged


def webhook_url(code: str, base_url: str = "") -> str:
    base = (app_settings.PUBLIC_API_URL or base_url or "").rstrip("/")
    prefix = app_settings.API_PREFIX.rstrip("/")
    if base.endswith(prefix):
        base = base[: -len(prefix)]
    return f"{base}{prefix}/shipping/webhooks/{code}"


def view(code: str, row: Optional[ProviderRow], *, with_credentials: bool, base_url: str = "") -> dict:
    cls = registry.adapter_class(code)
    adapter = registry.adapter_for(code, row)
    creds = adapter.credentials
    return {
        "code": code,
        "name": (row.name if row is not None and row.name else cls.name),
        "available": True,
        "description": cls.description,
        "environment": (row.environment if row is not None else "production") or "production",
        "environments": list(cls.environments),
        "active": bool(row.active) if row is not None else False,
        "isDefault": bool(row.is_default) if row is not None else False,
        "settings": settings_of(row),
        "credentialFields": [{"key": key, "label": label, "secret": bool(secret)}
                             for key, label, secret in cls.credential_fields],
        "credentials": ({key: mask_credential(key, creds.get(key, "")) for key, _, _ in cls.credential_fields
                         if creds.get(key)} if with_credentials else {}),
        "configured": adapter.configured(),
        "webhookUrl": webhook_url(code, base_url) if adapter.supports().get("webhook") else "",
        "lastTestedAt": row.last_tested_at if row is not None else None,
        "lastTestOk": row.last_test_ok if row is not None else None,
        "lastError": (row.last_error if row is not None else "") or "",
        "supports": adapter.supports(),
    }


def list_providers(db: Session, *, with_credentials: bool, base_url: str = "") -> List[dict]:
    return [view(code, registry.row_for(db, code), with_credentials=with_credentials, base_url=base_url)
            for code in registry.ADAPTERS]


# ------------------------------------------------------------------ saving


def _string(value: Any, limit: int, field: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        raise ValidationError(f"{field} must be text.", error_code="INVALID_SETTINGS", details={"field": field})
    return str(value).strip()[:limit]


def _clean_settings(current: dict, incoming: Any) -> dict:
    if incoming is None:
        return current
    if not isinstance(incoming, dict):
        raise ValidationError("Settings must be an object.", error_code="INVALID_SETTINGS")
    out = copy.deepcopy(current)
    if "services" in incoming:
        services = incoming["services"]
        if not isinstance(services, list) or len(services) > 20:
            raise ValidationError("Services must be a list of up to 20 names.", error_code="INVALID_SETTINGS")
        out["services"] = [name for name in (_string(s, 60, "services") for s in services) if name]
    if "defaultService" in incoming:
        out["defaultService"] = _string(incoming["defaultService"], 60, "defaultService")
    if "pickupLocation" in incoming:
        out["pickupLocation"] = _string(incoming["pickupLocation"], 100, "pickupLocation")
    if "checkoutServiceability" in incoming:
        if not isinstance(incoming["checkoutServiceability"], bool):
            raise ValidationError("checkoutServiceability must be true or false.", error_code="INVALID_SETTINGS")
        out["checkoutServiceability"] = incoming["checkoutServiceability"]
    if "origin" in incoming:
        origin = incoming["origin"]
        if not isinstance(origin, dict):
            raise ValidationError("The pickup address must be an object.", error_code="INVALID_SETTINGS")
        cleaned = dict(out["origin"])
        for field in ORIGIN_FIELDS:
            if field in origin:
                cleaned[field] = _string(origin[field], 255, f"origin.{field}")
        if cleaned["pincode"] and not PINCODE.match(cleaned["pincode"]):
            raise ValidationError("The pickup pincode must be 6 digits.", error_code="INVALID_SETTINGS",
                                  details={"field": "origin.pincode"})
        out["origin"] = cleaned
    if "defaultPackage" in incoming:
        raw = incoming["defaultPackage"]
        if raw in (None, {}):
            out["defaultPackage"] = None
        else:
            from app.services.shipping import service

            package = service.clean_package(raw, require_dimensions=False)
            out["defaultPackage"] = service.package_view(package)
    if out["defaultService"] and out["services"] and out["defaultService"] not in out["services"]:
        raise ValidationError("The default service must be one of the services.", error_code="INVALID_SETTINGS")
    return out


def save(db: Session, code: str, payload: dict, *, actor) -> ProviderRow:
    cls = registry.adapter_class(code)
    if cls is None:
        raise NotFoundError(f"There is no courier integration called '{code}'.", error_code="PROVIDER_NOT_FOUND")
    code = cls.code
    row = registry.row_for(db, code)
    creating = row is None
    now = datetime.utcnow()
    if row is None:
        row = ProviderRow(code=code, name=cls.name, environment="production", active=False, is_default=False,
                          credentials="", settings=copy.deepcopy(DEFAULT_SETTINGS), created_at=now, updated_at=now)
    before = {"name": row.name, "environment": row.environment, "active": row.active, "isDefault": row.is_default,
              "settings": settings_of(row) if not creating else None}

    if payload.get("name") is not None:
        name = _string(payload["name"], 80, "name")
        if not name:
            raise ValidationError("The name can't be blank.", error_code="INVALID_NAME")
        row.name = name
    if payload.get("environment") is not None:
        if payload["environment"] not in cls.environments:
            raise ValidationError(f"{cls.name} offers: {', '.join(cls.environments)}.",
                                  error_code="INVALID_ENVIRONMENT")
        row.environment = payload["environment"]
    row.settings = _clean_settings(settings_of(row), payload.get("settings"))

    # Credentials: write-only, only the adapter's own fields, blank keeps.
    changed_fields: List[str] = []
    incoming = payload.get("credentials")
    if incoming is not None:
        if not isinstance(incoming, dict):
            raise ValidationError("Credentials must be an object.", error_code="INVALID_CREDENTIALS")
        stored = registry.credentials_of(row)
        for key, _, _ in cls.credential_fields:
            value = incoming.get(key)
            if value is None or (isinstance(value, str) and not value.strip()):
                continue
            if not isinstance(value, str) or len(value) > 300:
                raise ValidationError("Each credential must be text of up to 300 characters.",
                                      error_code="INVALID_CREDENTIALS", details={"field": key})
            if stored.get(key) != value.strip():
                stored[key] = value.strip()
                changed_fields.append(key)
        if changed_fields:
            row.credentials = crypto.seal(stored)
            if code == "shiprocket":
                from app.services.shipping import shiprocket

                shiprocket.reset_tokens()

    if payload.get("active") is not None:
        if not isinstance(payload["active"], bool):
            raise ValidationError("active must be true or false.", error_code="INVALID_SETTINGS")
        row.active = payload["active"]
    if row.active:
        adapter = registry.adapter_for(code, row)
        if not adapter.configured():
            missing = [label for key, label, _ in cls.credential_fields
                       if key in cls.required_credentials and not adapter.credentials.get(key)]
            raise ValidationError(f"Enter {', '.join(missing)} before switching {cls.name} on.",
                                  error_code="CREDENTIALS_REQUIRED", details={"missing": missing})

    others = [r for r in db.execute(select(ProviderRow).where(ProviderRow.code != code)).scalars()]
    wants_default = payload.get("isDefault")
    if wants_default is not None and not isinstance(wants_default, bool):
        raise ValidationError("isDefault must be true or false.", error_code="INVALID_SETTINGS")
    if wants_default is True:
        if not row.active:
            raise ValidationError("Switch the courier on before making it the default.",
                                  error_code="PROVIDER_INACTIVE")
        row.is_default = True
    elif wants_default is False and row.is_default:
        if not any(r.active for r in others):
            raise ValidationError("One courier must be the default. Make another the default instead.",
                                  error_code="DEFAULT_REQUIRED")
        row.is_default = False
        promoted = next(r for r in others if r.active)
        promoted.is_default = True
    if row.is_default and not row.active:
        # Switched off while the default: the default moves to another active courier.
        row.is_default = False
        replacement = next((r for r in others if r.active), None)
        if replacement is not None:
            replacement.is_default = True
    if row.is_default:
        for other in others:
            other.is_default = False
    elif row.active and not any(r.is_default and r.active for r in others):
        row.is_default = True  # the first courier switched on becomes the default

    row.updated_at = now
    if creating:
        db.add(row)
    after = {"name": row.name, "environment": row.environment, "active": row.active, "isDefault": row.is_default,
             "settings": settings_of(row)}
    summary = f"Courier {cls.name} {'set up' if creating else 'updated'}"
    if changed_fields:
        summary += "; credentials updated (" + ", ".join(changed_fields) + ")"
    audit.record(db, "shipping-provider.update", resource_type="shipping-provider", resource_id=code, actor=actor,
                 summary=summary, changes=audit.diff(before, after))
    db.commit()
    db.refresh(row)
    return row


def test(db: Session, code: str, *, actor) -> dict:
    cls = registry.adapter_class(code)
    if cls is None:
        raise NotFoundError(f"There is no courier integration called '{code}'.", error_code="PROVIDER_NOT_FOUND")
    row = registry.row_for(db, cls.code)
    adapter = registry.adapter_for(cls.code, row)
    now = datetime.utcnow()
    if not adapter.configured():
        ok, message = False, "Enter the credentials first."
    else:
        try:
            ok, message = True, adapter.test_connection()
        except ProviderError as error:
            ok, message = False, error.message
    if row is None:
        row = ProviderRow(code=cls.code, name=cls.name, environment="production", active=False, is_default=False,
                          credentials="", settings=copy.deepcopy(DEFAULT_SETTINGS), created_at=now, updated_at=now)
        db.add(row)
    row.last_tested_at = now
    row.last_test_ok = ok
    row.last_error = "" if ok else message[:500]
    audit.record(db, "shipping-provider.test", resource_type="shipping-provider", resource_id=cls.code, actor=actor,
                 summary=f"Tested {cls.name}: {'connected' if ok else 'failed'}",
                 outcome="success" if ok else "failure")
    db.commit()
    return {"ok": ok, "message": message}
