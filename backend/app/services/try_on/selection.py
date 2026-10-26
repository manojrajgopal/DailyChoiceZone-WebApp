"""
Which model and which credential run a request.

Models: the enabled, verified models that support the request's capability
(and the plan's quality tiers), best priority first. A customer may name one
of those — a quality choice, never a credential — when their plan allows it.

Credentials, per model, are eligible when they are:

- not deleted, readable, not disabled or invalid, not resting after a rate
  limit, under their daily and monthly limits;
- for that model's provider, and (when restricted) for that model,
  capability and catalogue category;
- **shared and auto-selectable**, or **dedicated to this very customer** with
  an active allocation naming it.

That last rule is the isolation guarantee: a credential dedicated to one
customer is filtered out of every other customer's candidates here, in one
place, whatever the request says. Customers never send a credential id.

Dedicated credentials come first for their owner, then by priority, then the
least recently used — which spreads load across equal credentials.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import VtoAllocation, VtoAttempt, VtoCredential, VtoModel, VtoProvider, VtoRequest
from app.services.try_on import adapters, catalogue, crypto


@dataclass
class Candidate:
    model: VtoModel
    provider: VtoProvider
    credential: Optional[VtoCredential]


def models_for(db: Session, capability: str, *, quality_tiers: Optional[list] = None,
               requested_model_id: Optional[str] = None) -> List[VtoModel]:
    models = catalogue.runnable_models(db, capability)
    if quality_tiers:
        models = [m for m in models if m.quality_tier in quality_tiers]
    if requested_model_id:
        chosen = [m for m in models if m.id == requested_model_id]
        # The named model first; the rest stay as fallbacks.
        models = chosen + [m for m in models if m.id != requested_model_id]
    return models


def _attempts_since(db: Session, credential_id: str, since: datetime) -> int:
    return db.execute(select(func.count()).select_from(VtoAttempt).where(
        VtoAttempt.credential_id == credential_id, VtoAttempt.started_at >= since)).scalar_one()


def _dedicated_to(db: Session, customer_id: str, now: datetime) -> set:
    """Credentials this customer holds through an active dedicated allocation."""
    return set(db.execute(select(VtoAllocation.credential_id).where(
        VtoAllocation.customer_id == customer_id, VtoAllocation.status == "active",
        VtoAllocation.kind == "dedicated_credential", VtoAllocation.credential_id.is_not(None),
        VtoAllocation.starts_at <= now, (VtoAllocation.ends_at.is_(None)) | (VtoAllocation.ends_at > now),
    )).scalars())


def credential_usable(db: Session, credential: VtoCredential, *, customer_id: str, model: VtoModel,
                      capability: str, category_id: str, now: datetime, owned: set) -> bool:
    if credential.deleted_at is not None or not credential.secret_sealed:
        return False
    if credential.status in ("disabled", "invalid") or credential.validation_status == "invalid":
        return False
    if credential.status == "rate_limited" and credential.cooldown_until and credential.cooldown_until > now:
        return False
    if credential.provider_id != model.provider_id:
        return False
    if credential.model_ids and model.id not in credential.model_ids:
        return False
    if credential.capability_keys and capability not in credential.capability_keys:
        return False
    if credential.category_ids and category_id not in credential.category_ids:
        return False
    if credential.scope == "dedicated":
        # Isolation: only its owner, and only while an allocation grants it.
        if credential.dedicated_customer_id != customer_id or credential.id not in owned:
            return False
    elif not credential.auto_select:
        return False
    if credential.daily_limit is not None:
        if _attempts_since(db, credential.id, now.replace(hour=0, minute=0, second=0, microsecond=0)) >= credential.daily_limit:
            return False
    if credential.monthly_limit is not None:
        month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        if _attempts_since(db, credential.id, month) >= credential.monthly_limit:
            return False
    return crypto.unseal(credential.secret_sealed) is not None


def candidates(db: Session, request: VtoRequest, *, quality_tiers: Optional[list] = None,
               now: Optional[datetime] = None) -> List[Candidate]:
    """Every (model, credential) pair that may run the request, in the order to try them."""
    now = now or datetime.utcnow()
    owned = _dedicated_to(db, request.customer_id, now)
    credentials = db.execute(select(VtoCredential).where(VtoCredential.deleted_at.is_(None))).scalars().all()
    out: List[Candidate] = []
    for model in models_for(db, request.capability_key, quality_tiers=quality_tiers,
                            requested_model_id=request.requested_model_id):
        provider = db.get(VtoProvider, model.provider_id)
        if provider is None or not provider.enabled:
            continue
        usable = [c for c in credentials if credential_usable(
            db, c, customer_id=request.customer_id, model=model, capability=request.capability_key,
            category_id=request.category_id, now=now, owned=owned)]
        usable.sort(key=lambda c: (0 if c.scope == "dedicated" else 1, c.priority,
                                   c.last_used_at or datetime.min, c.id))
        if usable:
            out.extend(Candidate(model, provider, c) for c in usable)
        else:
            adapter = adapters.REGISTRY.get(model.adapter_key)
            if adapter is not None and not adapter.needs_secret:
                out.append(Candidate(model, provider, None))
    return out


def has_capacity(db: Session, customer_id: str, capability: str, category_id: str,
                 quality_tiers: Optional[list] = None) -> bool:
    """Whether a request could run at all right now — checked before accepting one."""
    probe = VtoRequest(customer_id=customer_id, capability_key=capability, category_id=category_id or "",
                       requested_model_id=None)
    return bool(candidates(db, probe, quality_tiers=quality_tiers))
