"""
Providers and models, as the portal manages them.

A provider row names an adapter family in code (`kind`). A model row names
one adapter, its endpoint configuration and the capabilities it handles —
never more than its adapter can. A model is only used for customers once it
is both **enabled** and **verified**: verification is an administrator's
statement that it was tested (the portal's "Test" runs one generation with
photos they provide, stores nothing, and shows the result).
"""

from __future__ import annotations

import base64
import time
from datetime import datetime
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import VtoCapability, VtoCredential, VtoHealthCheck, VtoModel, VtoProvider, VtoRequest
from app.services import audit
from app.services.try_on import adapters, crypto, images
from app.services.try_on.adapters.base import GenerationInput
from app.services.try_on.errors import ProviderFailure, TryOnError, describe
from app.utils.ids import next_id


def provider_out(row: VtoProvider) -> dict:
    return {"id": row.id, "kind": row.kind, "name": row.name, "enabled": row.enabled,
            "timeoutSeconds": row.timeout_seconds, "maxRetries": row.max_retries,
            "cooldownSeconds": row.cooldown_seconds, "health": row.health, "healthDetail": row.health_detail,
            "lastCheckedAt": row.last_checked_at}


def model_out(row: VtoModel) -> dict:
    adapter = adapters.REGISTRY.get(row.adapter_key)
    return {"id": row.id, "providerId": row.provider_id, "name": row.name, "description": row.description,
            "adapterKey": row.adapter_key, "adapterLabel": adapter.label if adapter else "Unknown adapter",
            "adapterAvailable": adapter is not None and (not adapter.development_only or adapters.mock_allowed()),
            "config": row.config or {}, "capabilities": row.capabilities or [], "qualityTier": row.quality_tier,
            "enabled": row.enabled, "verified": row.verified, "priority": row.priority,
            "avgSeconds": row.avg_seconds,
            "costPerCall": float(row.cost_per_call) if row.cost_per_call is not None else None,
            "costCurrency": row.cost_currency, "routable": row.enabled and row.verified}


def providers(db: Session) -> List[VtoProvider]:
    return list(db.execute(select(VtoProvider).order_by(VtoProvider.id)).scalars())


def models(db: Session) -> List[VtoModel]:
    return list(db.execute(select(VtoModel).order_by(VtoModel.priority, VtoModel.id)).scalars())


def get_provider(db: Session, provider_id: str) -> VtoProvider:
    row = db.get(VtoProvider, (provider_id or "")[:20])
    if row is None:
        raise NotFoundError("We couldn't find that provider.", error_code="PROVIDER_NOT_FOUND")
    return row


def get_model(db: Session, model_id: str) -> VtoModel:
    row = db.get(VtoModel, (model_id or "")[:20])
    if row is None:
        raise NotFoundError("We couldn't find that model.", error_code="MODEL_NOT_FOUND")
    return row


def _int(payload: dict, key: str, low: int, high: int) -> Optional[int]:
    if key not in payload:
        return None
    try:
        value = int(payload[key])
    except (TypeError, ValueError):
        raise ValidationError(f"Check {key}.", error_code="INVALID_VALUE") from None
    if not low <= value <= high:
        raise ValidationError(f"{key} must be between {low} and {high}.", error_code="INVALID_VALUE")
    return value


def save_provider(db: Session, payload: dict, provider_id: Optional[str] = None) -> VtoProvider:
    if not isinstance(payload, dict):
        raise ValidationError("Send the provider as an object.", error_code="INVALID_PROVIDER")
    now = datetime.utcnow()
    if provider_id:
        row = get_provider(db, provider_id)
    else:
        kind = str(payload.get("kind") or "")
        if kind not in adapters.provider_kinds():
            raise ValidationError("Choose a provider type this server supports.", error_code="UNKNOWN_KIND")
        row = VtoProvider(id=next_id(db, VtoProvider, "vto_provider"), kind=kind, name=kind, enabled=False,
                          timeout_seconds=120, max_retries=2, cooldown_seconds=900, health="unknown",
                          health_detail="", config={}, created_at=now, updated_at=now)
    if "name" in payload:
        row.name = str(payload["name"] or "").strip()[:80] or row.name
    if "enabled" in payload:
        row.enabled = payload["enabled"] is True
    for key, attribute, low, high in (("timeoutSeconds", "timeout_seconds", 10, 600), ("maxRetries", "max_retries", 0, 5),
                                      ("cooldownSeconds", "cooldown_seconds", 60, 86400)):
        value = _int(payload, key, low, high)
        if value is not None:
            setattr(row, attribute, value)
    row.updated_at = now
    if row not in db:
        db.add(row)
    db.flush()
    return row


def check_provider(db: Session, provider_id: str) -> VtoProvider:
    """Validate the provider's credentials; its health is what they say."""
    from app.services.try_on import credentials

    row = get_provider(db, provider_id)
    usable = db.execute(select(VtoCredential).where(
        VtoCredential.provider_id == row.id, VtoCredential.deleted_at.is_(None),
        VtoCredential.status != "disabled")).scalars().all()
    now = datetime.utcnow()
    if not usable:
        adapter = adapters.REGISTRY.get(next((k for k, a in adapters.REGISTRY.items() if a.provider_kind == row.kind), ""))
        if adapter is not None and not adapter.needs_secret:
            row.health, row.health_detail = "healthy", "Runs without credentials."
        else:
            row.health, row.health_detail = "down", "No usable credentials."
    else:
        results = [credentials.validate(db, c.id) for c in usable[:5]]
        good = sum(1 for c in results if c.validation_status == "valid")
        row.health = "healthy" if good == len(results) else "degraded" if good else "down"
        row.health_detail = f"{good} of {len(results)} credentials accepted."
    row.last_checked_at, row.updated_at = now, now
    db.add(VtoHealthCheck(target_type="provider", target_id=row.id, ok=row.health == "healthy", latency_ms=0,
                          error_code="" if row.health == "healthy" else "provider_unavailable",
                          detail=row.health_detail[:300], checked_at=now))
    return row


def save_model(db: Session, payload: dict, model_id: Optional[str] = None) -> VtoModel:
    if not isinstance(payload, dict):
        raise ValidationError("Send the model as an object.", error_code="INVALID_MODEL")
    now = datetime.utcnow()
    if model_id:
        row = get_model(db, model_id)
        before = model_out(row)
    else:
        provider = get_provider(db, str(payload.get("providerId") or ""))
        adapter_key = str(payload.get("adapterKey") or "")
        try:
            adapter = adapters.get(adapter_key)
        except KeyError:
            raise ValidationError("Choose an adapter this server supports.", error_code="UNKNOWN_ADAPTER") from None
        if adapter.provider_kind != provider.kind:
            raise ValidationError("That adapter belongs to another kind of provider.", error_code="ADAPTER_MISMATCH")
        row = VtoModel(id=next_id(db, VtoModel, "vto_model"), provider_id=provider.id, name=adapter.label,
                       description="", adapter_key=adapter_key, config={}, capabilities=[], quality_tier="standard",
                       enabled=False, verified=False, priority=100, avg_seconds=45, cost_currency="USD",
                       created_at=now, updated_at=now)
        before = None
    if "name" in payload:
        row.name = str(payload["name"] or "").strip()[:120] or row.name
    if "description" in payload:
        row.description = str(payload["description"] or "").strip()[:300]
    if "config" in payload:
        if not isinstance(payload["config"], dict):
            raise ValidationError("The configuration is an object.", error_code="INVALID_CONFIG")
        config = payload["config"]
        if "params" in config and not isinstance(config["params"], dict):
            raise ValidationError("Parameters are an object.", error_code="INVALID_CONFIG")
        if len(str(config)) > 4000:
            raise ValidationError("The configuration is too large.", error_code="INVALID_CONFIG")
        row.config = config
    if "capabilities" in payload:
        keys = payload["capabilities"] if isinstance(payload["capabilities"], list) else None
        if keys is None:
            raise ValidationError("Capabilities are a list.", error_code="INVALID_CAPABILITIES")
        keys = [str(k)[:60] for k in keys][:20]
        known = set(db.execute(select(VtoCapability.key)).scalars())
        bad = [k for k in keys if k not in known or not adapters.supports(row.adapter_key, k)]
        if bad:
            raise ValidationError(f"This adapter can't do: {', '.join(bad)}.", error_code="UNSUPPORTED_CAPABILITY")
        row.capabilities = sorted(set(keys))
    if "qualityTier" in payload:
        row.quality_tier = str(payload["qualityTier"] or "standard").strip().lower()[:20] or "standard"
    for key in ("enabled", "verified"):
        if key in payload:
            setattr(row, key, payload[key] is True)
    value = _int(payload, "priority", 0, 10000)
    if value is not None:
        row.priority = value
    value = _int(payload, "avgSeconds", 1, 3600)
    if value is not None:
        row.avg_seconds = value
    if "costPerCall" in payload:
        raw = payload["costPerCall"]
        if raw in (None, ""):
            row.cost_per_call = None
        else:
            try:
                row.cost_per_call = max(0.0, min(float(raw), 1000.0))
            except (TypeError, ValueError):
                raise ValidationError("Cost is a number.", error_code="INVALID_VALUE") from None
    if "costCurrency" in payload:
        row.cost_currency = str(payload["costCurrency"] or "USD").upper()[:3]
    if row.enabled and not row.capabilities:
        raise ValidationError("List what the model can try on before enabling it.", error_code="NO_CAPABILITIES")
    row.updated_at = now
    if row not in db:
        db.add(row)
    db.flush()
    audit.record(db, "try_on_model.save", resource_type="try-on-model", resource_id=row.id,
                 summary=f"Saved model {row.name}", changes=audit.diff(before, model_out(row)) if before else None)
    return row


def delete_model(db: Session, model_id: str) -> str:
    row = get_model(db, model_id)
    used = db.execute(select(func.count()).select_from(VtoRequest).where(VtoRequest.model_id == row.id)).scalar_one()
    if used:
        row.enabled = False
        row.updated_at = datetime.utcnow()
        return "disabled"
    db.delete(row)
    db.flush()
    return "deleted"


def test_model(db: Session, model_id: str, capability: str, person: bytes, garment: bytes,
               credential_id: Optional[str] = None) -> dict:
    """
    One generation with the administrator's own photos — to verify a model
    before customers use it. Nothing is stored; the result comes back inline.
    """
    row = get_model(db, model_id)
    provider = get_provider(db, row.provider_id)
    if capability not in (row.capabilities or []) and not adapters.supports(row.adapter_key, capability):
        raise ValidationError("This model doesn't list that capability.", error_code="UNSUPPORTED_CAPABILITY")
    try:
        adapter = adapters.get(row.adapter_key)
    except KeyError:
        raise ValidationError("This model's adapter isn't available here.", error_code="UNKNOWN_ADAPTER") from None
    person_img = images.normalise(person, max_bytes=images.HARD_MAX_BYTES).data
    garment_img = images.normalise(garment, max_bytes=images.HARD_MAX_BYTES).data
    secret = None
    if credential_id:
        credential = db.get(VtoCredential, credential_id[:20])
        if credential is None or credential.provider_id != provider.id or credential.deleted_at is not None:
            raise ValidationError("Choose a credential of this provider.", error_code="INVALID_CREDENTIAL")
        secret = crypto.unseal(credential.secret_sealed)
    else:
        for credential in db.execute(select(VtoCredential).where(
                VtoCredential.provider_id == provider.id, VtoCredential.deleted_at.is_(None),
                VtoCredential.status.in_(("active", "rate_limited")))
                .order_by(VtoCredential.priority)).scalars():
            secret = crypto.unseal(credential.secret_sealed)
            if secret:
                break
    if secret is None and adapter.needs_secret:
        raise ConflictError("Add a credential for this provider first.", error_code="NO_CREDENTIAL")
    started = time.monotonic()
    try:
        result = adapter.generate(GenerationInput(capability, person_img, garment_img, "test"), secret=secret,
                                  config=row.config or {}, timeout=max(10, provider.timeout_seconds))
        data = images.normalise(result.data, max_bytes=images.HARD_MAX_BYTES).data
    except TryOnError as error:
        return {"ok": False, "code": "bad_provider_response", "explanation": describe("bad_provider_response").admin,
                "detail": error.message, "latencyMs": int((time.monotonic() - started) * 1000)}
    except Exception as error:  # noqa: BLE001 — the test reports what went wrong
        failure: ProviderFailure = adapter.classify(error)
        return {"ok": False, "code": failure.code, "explanation": failure.failure.admin, "detail": failure.detail,
                "latencyMs": int((time.monotonic() - started) * 1000)}
    return {"ok": True, "latencyMs": int((time.monotonic() - started) * 1000),
            "image": "data:image/jpeg;base64," + base64.b64encode(data).decode()}
