"""
Provider credentials: added, rotated, validated, hidden, disabled, deleted.

The rules that matter:

- A secret goes in once and never comes out. Responses carry a mask, the last
  four characters and the state — never the secret, sealed or not.
- *Hidden* only keeps a credential out of the ordinary list; it is still
  used. *Disabled* stops it being used. *Invalid* and *rate-limited* are what
  the provider said, and are set by validation or by real calls. *Deleted*
  wipes the secret and keeps the row, so history still names it.
- A *dedicated* credential belongs to one customer and is never picked for
  anyone else (see `selection`). It is never auto-selected for others.
- A credential is only shown as healthy after the provider accepted it.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import Customer, VtoCredential, VtoHealthCheck, VtoModel, VtoProvider, VtoRequest
from app.services import audit
from app.services.try_on import adapters, crypto
from app.services.try_on.adapters.huggingface import forget_clients
from app.services.try_on.errors import ProviderFailure, describe
from app.utils.ids import next_id

logger = logging.getLogger(__name__)

_SECRET = re.compile(r"^\S{8,500}$")
MAX_BULK = 200


def _bad_secret(secret: str) -> bool:
    return not _SECRET.match(secret or "")


def get(db: Session, credential_id: str, *, include_deleted: bool = True) -> VtoCredential:
    row = db.get(VtoCredential, (credential_id or "")[:20])
    if row is None or (row.deleted_at is not None and not include_deleted):
        raise NotFoundError("We couldn't find that credential.", error_code="CREDENTIAL_NOT_FOUND")
    return row


def _provider(db: Session, provider_id: str) -> VtoProvider:
    provider = db.get(VtoProvider, (provider_id or "")[:20])
    if provider is None:
        raise ValidationError("Choose a provider.", error_code="PROVIDER_REQUIRED")
    return provider


def effective_status(row: VtoCredential, now: Optional[datetime] = None) -> str:
    """deleted | disabled | invalid | rate_limited | unhealthy | check_failed | unvalidated | healthy"""
    now = now or datetime.utcnow()
    if row.deleted_at is not None:
        return "deleted"
    if row.status == "disabled":
        return "disabled"
    if row.status == "invalid" or row.validation_status == "invalid":
        return "invalid"
    if row.status == "rate_limited" and row.cooldown_until and row.cooldown_until > now:
        return "rate_limited"
    if row.consecutive_failures >= 3:
        return "unhealthy"
    if row.validation_status == "valid" or row.success_count > 0:
        return "healthy"
    # Checked, but the provider couldn't be reached: not the same as never checked.
    if row.validation_status == "error":
        return "check_failed"
    return "unvalidated"


def out(row: VtoCredential) -> dict:
    """Everything an administrator may see — never the secret."""
    error = describe(row.last_error_code) if row.last_error_code else None
    return {
        "id": row.id,
        "providerId": row.provider_id,
        "label": row.label,
        "masked": crypto.mask(row.last4) if row.secret_sealed else "",
        "status": row.status,
        "state": effective_status(row),
        "hidden": row.hidden,
        "autoSelect": row.auto_select,
        "priority": row.priority,
        "scope": row.scope,
        "dedicatedCustomerId": row.dedicated_customer_id,
        "modelIds": row.model_ids or [],
        "capabilityKeys": row.capability_keys or [],
        "categoryIds": row.category_ids or [],
        "dailyLimit": row.daily_limit,
        "monthlyLimit": row.monthly_limit,
        "validationStatus": row.validation_status,
        "lastValidatedAt": row.last_validated_at,
        "cooldownUntil": row.cooldown_until,
        "consecutiveFailures": row.consecutive_failures,
        "lastErrorCode": row.last_error_code,
        "lastError": error.admin if error else "",
        "lastErrorAt": row.last_error_at,
        "rateLimitInfo": row.rate_limit_info,
        "successCount": row.success_count,
        "failureCount": row.failure_count,
        "lastUsedAt": row.last_used_at,
        "rotatedAt": row.rotated_at,
        "deletedAt": row.deleted_at,
        "createdAt": row.created_at,
        "createdBy": row.created_by,
    }


def list_credentials(db: Session, *, include_hidden: bool = False, include_deleted: bool = False,
                     provider_id: str = "", state: str = "") -> List[VtoCredential]:
    query = select(VtoCredential).order_by(VtoCredential.priority, VtoCredential.id)
    if not include_hidden:
        query = query.where(VtoCredential.hidden.is_(False))
    if not include_deleted:
        query = query.where(VtoCredential.deleted_at.is_(None))
    if provider_id:
        query = query.where(VtoCredential.provider_id == provider_id[:20])
    rows = list(db.execute(query).scalars())
    if state:
        rows = [r for r in rows if effective_status(r) == state]
    return rows


def counts(db: Session) -> dict:
    rows = db.execute(select(VtoCredential)).scalars().all()
    tally = {"total": 0, "hidden": 0, "deleted": 0, "active": 0, "disabled": 0, "invalid": 0, "rate_limited": 0,
             "unhealthy": 0, "healthy": 0, "unvalidated": 0, "check_failed": 0, "dedicated": 0}
    for row in rows:
        state = effective_status(row)
        tally[state] = tally.get(state, 0) + 1
        if state != "deleted":
            tally["total"] += 1
            tally["hidden"] += int(row.hidden)
            tally["dedicated"] += int(row.scope == "dedicated")
            if state in ("healthy", "unvalidated", "unhealthy", "check_failed"):
                tally["active"] += 1
    return tally


# ------------------------------------------------------------------ writing


def _ids(value, name: str) -> list:
    if value in (None, ""):
        return []
    if not isinstance(value, list) or not all(isinstance(v, (str, int)) for v in value):
        raise ValidationError(f"{name} must be a list.", error_code="INVALID_CREDENTIAL")
    return [str(v)[:60] for v in value][:50]


def _apply(db: Session, row: VtoCredential, payload: dict) -> None:
    from app.models import Category, VtoCapability

    if "label" in payload:
        label = str(payload["label"] or "").strip()[:80]
        if not label:
            raise ValidationError("Give the credential a name.", error_code="LABEL_REQUIRED")
        row.label = label
    for key, attribute in (("hidden", "hidden"), ("autoSelect", "auto_select")):
        if key in payload:
            setattr(row, attribute, payload[key] is True)
    if "priority" in payload:
        try:
            row.priority = max(0, min(int(payload["priority"]), 10000))
        except (TypeError, ValueError):
            raise ValidationError("Priority is a number.", error_code="INVALID_CREDENTIAL") from None
    for key, attribute in (("dailyLimit", "daily_limit"), ("monthlyLimit", "monthly_limit")):
        if key in payload:
            value = payload[key]
            if value in (None, ""):
                setattr(row, attribute, None)
            else:
                try:
                    number = int(value)
                except (TypeError, ValueError):
                    raise ValidationError("Limits are whole numbers.", error_code="INVALID_CREDENTIAL") from None
                if number < 1:
                    raise ValidationError("Limits are at least 1, or empty for none.", error_code="INVALID_CREDENTIAL")
                setattr(row, attribute, number)

    if "modelIds" in payload:
        model_ids = _ids(payload["modelIds"], "Models")
        models = db.execute(select(VtoModel).where(VtoModel.id.in_(model_ids))).scalars().all() if model_ids else []
        if len(models) != len(set(model_ids)) or any(m.provider_id != row.provider_id for m in models):
            raise ValidationError("Choose models of this credential's provider.", error_code="INVALID_MODELS")
        row.model_ids = sorted(set(model_ids))
    if "capabilityKeys" in payload:
        keys = _ids(payload["capabilityKeys"], "Try-on types")
        known = set(db.execute(select(VtoCapability.key)).scalars())
        if any(k not in known for k in keys):
            raise ValidationError("Choose known try-on types.", error_code="INVALID_CAPABILITIES")
        # Only types the credential's models can actually do.
        query = select(VtoModel).where(VtoModel.provider_id == row.provider_id)
        if row.model_ids:
            query = query.where(VtoModel.id.in_(row.model_ids))
        supported = {c for m in db.execute(query).scalars() for c in (m.capabilities or [])}
        unsupported = [k for k in keys if k not in supported]
        if unsupported:
            raise ValidationError(
                f"No model of this credential supports: {', '.join(unsupported)}.", error_code="UNSUPPORTED_CAPABILITY"
            )
        row.capability_keys = sorted(set(keys))
    if "categoryIds" in payload:
        ids = _ids(payload["categoryIds"], "Categories")
        found = set(db.execute(select(Category.id).where(Category.id.in_(ids))).scalars()) if ids else set()
        if found != set(ids):
            raise ValidationError("Choose existing categories.", error_code="INVALID_CATEGORIES")
        row.category_ids = sorted(found)

    if "scope" in payload:
        if payload["scope"] not in ("shared", "dedicated"):
            raise ValidationError("Scope is shared or dedicated.", error_code="INVALID_SCOPE")
        row.scope = payload["scope"]
    if "dedicatedCustomerId" in payload:
        customer_id = str(payload["dedicatedCustomerId"] or "").strip()[:20] or None
        if customer_id and db.get(Customer, customer_id) is None:
            raise ValidationError("That customer doesn't exist.", error_code="CUSTOMER_NOT_FOUND")
        row.dedicated_customer_id = customer_id
    if row.scope == "dedicated":
        if not row.dedicated_customer_id:
            raise ValidationError("Choose the customer this credential is dedicated to.", error_code="CUSTOMER_REQUIRED")
        # A dedicated credential is never picked for anyone else's requests.
        row.auto_select = False
    else:
        row.dedicated_customer_id = None


def _secret_fields(row: VtoCredential, secret: str) -> None:
    row.secret_sealed = crypto.seal(secret)
    row.fingerprint = crypto.fingerprint(secret)
    row.last4 = secret[-4:]


def _duplicate(db: Session, secret: str, ignore_id: Optional[str] = None) -> bool:
    found = db.execute(select(VtoCredential.id).where(VtoCredential.fingerprint == crypto.fingerprint(secret))).scalar()
    return found is not None and found != ignore_id


def add(db: Session, payload: dict, *, admin_id: str = "") -> VtoCredential:
    if not isinstance(payload, dict):
        raise ValidationError("Send the credential as an object.", error_code="INVALID_CREDENTIAL")
    provider = _provider(db, str(payload.get("providerId") or ""))
    secret = str(payload.get("secret") or "").strip()
    if _bad_secret(secret):
        raise ValidationError("Paste the full token: at least 8 characters, no spaces.", error_code="INVALID_SECRET")
    if _duplicate(db, secret):
        raise ConflictError("That token is already saved.", error_code="CREDENTIAL_EXISTS")
    now = datetime.utcnow()
    row = VtoCredential(
        id=next_id(db, VtoCredential, "vto_credential"), provider_id=provider.id, label="", status="active",
        hidden=False, auto_select=True, priority=100, scope="shared", model_ids=[], capability_keys=[],
        category_ids=[], validation_status="unvalidated", consecutive_failures=0, last_error_code="",
        success_count=0, failure_count=0, created_by=admin_id[:20], created_at=now, updated_at=now,
    )
    _secret_fields(row, secret)
    # Checked before the row joins the session, so a refusal leaves nothing behind.
    _apply(db, row, {"label": payload.get("label") or f"{provider.name} token", **{
        k: v for k, v in payload.items() if k not in ("secret", "providerId", "label")}})
    db.add(row)
    db.flush()
    audit.record(db, "try_on_credential.create", resource_type="try-on-credential", resource_id=row.id,
                 summary=f"Added credential {row.label} (…{row.last4})")
    return row


def bulk_add(db: Session, payload: dict, *, admin_id: str = "") -> dict:
    """
    Several tokens at once: `secrets` as a list or one per line. Duplicates and
    malformed lines are skipped and reported by line number — never echoed.
    """
    if not isinstance(payload, dict):
        raise ValidationError("Send the tokens as an object.", error_code="INVALID_CREDENTIAL")
    raw = payload.get("secrets")
    lines = raw.splitlines() if isinstance(raw, str) else raw if isinstance(raw, list) else []
    lines = [str(line).strip() for line in lines]
    if not any(lines):
        raise ValidationError("Paste at least one token.", error_code="SECRETS_REQUIRED")
    if len(lines) > MAX_BULK:
        raise ValidationError(f"Up to {MAX_BULK} tokens at a time.", error_code="TOO_MANY")
    prefix = str(payload.get("labelPrefix") or "").strip()[:60]
    shared = {k: v for k, v in payload.items() if k not in ("secrets", "labelPrefix", "label")}
    added, skipped, seen = [], [], set()
    for number, secret in enumerate(lines, start=1):
        if not secret:
            continue
        if _bad_secret(secret):
            skipped.append({"line": number, "reason": "not a token (too short or contains spaces)"})
            continue
        fingerprint = crypto.fingerprint(secret)
        if fingerprint in seen or _duplicate(db, secret):
            skipped.append({"line": number, "reason": "already saved"})
            continue
        seen.add(fingerprint)
        label = f"{prefix or 'Token'} {len(added) + 1}"
        row = add(db, {**shared, "secret": secret, "label": label}, admin_id=admin_id)
        added.append(row)
    return {"added": added, "skipped": skipped}


def update(db: Session, credential_id: str, payload: dict) -> VtoCredential:
    if not isinstance(payload, dict):
        raise ValidationError("Send the changes as an object.", error_code="INVALID_CREDENTIAL")
    row = get(db, credential_id, include_deleted=False)
    before = audit.snapshot(row, ("label", "hidden", "auto_select", "priority", "scope", "dedicated_customer_id",
                                  "model_ids", "capability_keys", "category_ids", "daily_limit", "monthly_limit"))
    _apply(db, row, {k: v for k, v in payload.items() if k not in ("secret", "providerId")})
    row.updated_at = datetime.utcnow()
    after = audit.snapshot(row, before.keys())
    audit.record(db, "try_on_credential.update", resource_type="try-on-credential", resource_id=row.id,
                 summary=f"Updated credential {row.label}", changes=audit.diff(before, after))
    return row


def rotate(db: Session, credential_id: str, secret: str) -> VtoCredential:
    """Replace the secret. History stays with the credential; health starts again."""
    row = get(db, credential_id, include_deleted=False)
    secret = (secret or "").strip()
    if _bad_secret(secret):
        raise ValidationError("Paste the full token: at least 8 characters, no spaces.", error_code="INVALID_SECRET")
    if _duplicate(db, secret, ignore_id=row.id):
        raise ConflictError("That token is already saved.", error_code="CREDENTIAL_EXISTS")
    now = datetime.utcnow()
    _secret_fields(row, secret)
    row.status = "active" if row.status != "disabled" else "disabled"
    row.validation_status, row.consecutive_failures = "unvalidated", 0
    row.cooldown_until, row.last_error_code, row.rotated_at, row.updated_at = None, "", now, now
    forget_clients()
    audit.record(db, "try_on_credential.rotate", resource_type="try-on-credential", resource_id=row.id,
                 summary=f"Replaced the token of {row.label} (now …{row.last4})")
    return row


def set_state(db: Session, credential_id: str, action: str) -> VtoCredential:
    row = get(db, credential_id, include_deleted=False)
    now = datetime.utcnow()
    if action == "enable":
        row.status, row.cooldown_until, row.consecutive_failures = "active", None, 0
    elif action == "disable":
        row.status = "disabled"
    elif action == "hide":
        row.hidden = True
    elif action == "unhide":
        row.hidden = False
    else:
        raise ValidationError("Unknown action.", error_code="INVALID_ACTION")
    row.updated_at = now
    audit.record(db, f"try_on_credential.{action}", resource_type="try-on-credential", resource_id=row.id,
                 summary=f"{action.capitalize()}d credential {row.label}")
    return row


def delete(db: Session, credential_id: str) -> VtoCredential:
    """Wipe the secret, keep the row: requests and reports still name it."""
    from app.models import VtoAllocation

    row = get(db, credential_id, include_deleted=False)
    now = datetime.utcnow()
    row.secret_sealed, row.fingerprint = None, None
    row.status, row.deleted_at, row.updated_at = "disabled", now, now
    row.auto_select = False
    for allocation in db.execute(select(VtoAllocation).where(
            VtoAllocation.credential_id == row.id, VtoAllocation.status == "active")).scalars():
        allocation.note = (allocation.note + " · Dedicated credential deleted.").strip(" ·")[:500]
        allocation.updated_at = now
    forget_clients()
    audit.record(db, "try_on_credential.delete", resource_type="try-on-credential", resource_id=row.id,
                 summary=f"Deleted credential {row.label} (…{row.last4}); its secret was erased")
    return row


def adapter_for_provider(provider: VtoProvider):
    for key, adapter in adapters.REGISTRY.items():
        if adapter.provider_kind == provider.kind:
            try:
                return adapters.get(key)
            except KeyError:
                continue
    return None


def validate(db: Session, credential_id: str) -> VtoCredential:
    """Ask the provider whether it accepts the credential, without generating anything."""
    row = get(db, credential_id, include_deleted=False)
    provider = db.get(VtoProvider, row.provider_id)
    adapter = adapter_for_provider(provider) if provider else None
    now = datetime.utcnow()
    secret = crypto.unseal(row.secret_sealed)
    if secret is None:
        result_ok, code, detail, latency, info = False, "invalid_credentials", \
            "The stored secret can't be read with the configured encryption key. Replace the token.", 0, {}
    elif adapter is None:
        result_ok, code, detail, latency, info = False, "provider_unavailable", "No adapter for this provider.", 0, {}
    else:
        result = adapter.check_credential(secret, config=provider.config or {})
        result_ok, code, detail, latency, info = result.ok, result.code, result.detail, result.latency_ms, result.info
    from app.services.try_on.errors import sanitize

    db.add(VtoHealthCheck(target_type="credential", target_id=row.id, ok=result_ok, latency_ms=latency,
                          error_code=code, detail=sanitize(detail, 300), checked_at=now))
    row.last_validated_at = now
    if result_ok:
        row.validation_status = "valid"
        # The earlier problem is over; its record stays in the health checks.
        row.last_error_code, row.last_error_at = "", None
        if row.status == "invalid":
            row.status = "active"
        row.rate_limit_info = info or row.rate_limit_info
    elif code == "invalid_credentials":
        row.validation_status = "invalid"
        if row.status != "disabled":
            row.status = "invalid"
        row.last_error_code, row.last_error_at = code, now
    else:
        row.validation_status = "error"
        row.last_error_code, row.last_error_at = code, now
    row.updated_at = now
    return row


def reencrypt(db: Session) -> dict:
    """After a key rotation: seal every stored secret with the current key."""
    done = unreadable = 0
    for row in db.execute(select(VtoCredential).where(VtoCredential.secret_sealed.is_not(None))).scalars():
        if crypto.sealed_with_current_key(row.secret_sealed):
            secret = crypto.unseal(row.secret_sealed)
            if secret is not None:
                row.fingerprint = crypto.fingerprint(secret)
            continue
        sealed = crypto.reseal(row.secret_sealed)
        if sealed is None:
            unreadable += 1
            row.status, row.validation_status = "invalid", "invalid"
            row.last_error_code, row.last_error_at = "invalid_credentials", datetime.utcnow()
            continue
        row.secret_sealed = sealed
        row.fingerprint = crypto.fingerprint(crypto.unseal(sealed) or "")
        done += 1
    audit.record(db, "try_on_credential.reencrypt", resource_type="try-on-credential",
                 summary=f"Re-encrypted {done} credentials ({unreadable} unreadable)")
    return {"reencrypted": done, "unreadable": unreadable}


# ------------------------------------------------------------- from the worker


def record_outcome(db: Session, row: Optional[VtoCredential], failure: Optional[ProviderFailure],
                   provider: Optional[VtoProvider]) -> None:
    """What a real call says about the credential's health."""
    if row is None:
        return
    now = datetime.utcnow()
    row.last_used_at = now
    row.updated_at = now
    if failure is None:
        row.success_count += 1
        row.consecutive_failures = 0
        row.last_error_code, row.last_error_at = "", None
        if row.status == "rate_limited":
            row.status, row.cooldown_until = "active", None
        if row.validation_status in ("unvalidated", "error"):
            row.validation_status = "valid"
        return
    row.failure_count += 1
    if failure.failure.scope != "credential":
        return
    row.consecutive_failures += 1
    row.last_error_code, row.last_error_at = failure.code, now
    if failure.code == "invalid_credentials":
        was = row.status
        row.status, row.validation_status = "invalid", "invalid"
        if was != "invalid":
            _tell_staff(db, row, "A try-on credential was rejected",
                        f"{row.label} (…{row.last4}) was rejected by the provider and is no longer used. Replace it.")
    elif failure.code == "rate_limited":
        seconds = failure.retry_after or (provider.cooldown_seconds if provider else 900)
        row.status = "rate_limited"
        row.cooldown_until = now + timedelta(seconds=max(60, min(int(seconds), 86400)))
        row.rate_limit_info = {"reason": failure.detail[:200], "until": row.cooldown_until.isoformat()}


def _tell_staff(db: Session, row: VtoCredential, title: str, body: str) -> None:
    try:
        from app.services import inbox

        inbox.staff(db, "try-on", title, body, href="/admin/try-on/credentials", permission="try-on-credentials",
                    key=f"vto-cred-{row.id}-{row.status}")
    except Exception:  # noqa: BLE001 — an alert never breaks the work
        logger.warning("Could not alert staff about credential %s", row.id)


def usage(db: Session, credential_id: str, *, limit: int = 20) -> dict:
    """Who used a credential, and under which plans."""
    row = get(db, credential_id)
    by_customer = db.execute(
        select(VtoRequest.customer_id, func.count(), func.sum(func.if_(VtoRequest.status == "succeeded", 1, 0)))
        .where(VtoRequest.credential_id == row.id).group_by(VtoRequest.customer_id)
        .order_by(func.count().desc()).limit(limit)
    ).all()
    names = {c.id: c.full_name for c in db.execute(select(Customer).where(
        Customer.id.in_([r[0] for r in by_customer]))).scalars()} if by_customer else {}
    by_plan = db.execute(
        select(VtoRequest.source, VtoRequest.plan_name, func.count())
        .where(VtoRequest.credential_id == row.id).group_by(VtoRequest.source, VtoRequest.plan_name)
    ).all()
    checks = db.execute(select(VtoHealthCheck).where(
        VtoHealthCheck.target_type == "credential", VtoHealthCheck.target_id == row.id)
        .order_by(VtoHealthCheck.checked_at.desc()).limit(10)).scalars().all()
    return {
        "credential": out(row),
        "customers": [{"customerId": c, "name": names.get(c, ""), "requests": int(n), "succeeded": int(s or 0)}
                      for c, n, s in by_customer],
        "plans": [{"source": src, "plan": plan or ("Trial" if src == "trial" else "—"), "requests": int(n)}
                  for src, plan, n in by_plan],
        "healthChecks": [{"ok": c.ok, "code": c.error_code, "detail": c.detail, "latencyMs": c.latency_ms,
                          "checkedAt": c.checked_at} for c in checks],
    }
