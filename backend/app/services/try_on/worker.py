"""
The generation worker: takes queued try-ons and runs them.

Requests are claimed with `SELECT … FOR UPDATE SKIP LOCKED` and a lease, so
several server processes can share the queue without taking the same one.
A request whose lease runs out (its process died) is put back or failed by the
housekeeping job. Generation runs in a thread: the web workers are never held
for the length of an AI call.

For each request:

1. the entitlement is checked again — a membership may have ended since it
   was queued;
2. the customer's photo and the product photo are loaded and checked;
3. candidates are tried in order (`selection`): a credential failure moves
   to the next credential, a model failure to the next model, a request
   failure (a bad photo) stops at once. Each call is an attempt, and each
   attempt tells the credential's health (`credentials.record_outcome`);
4. a result is checked to be an image, re-encoded and stored as the plan
   says. If the preferred storage fails, the result is kept in ephemeral
   storage rather than lost, and the request says so;
5. quota is consumed on success and given back otherwise.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Customer, Product, VtoAllocation, VtoAttempt, VtoCredential, VtoPhoto, VtoRequest
from app.services.try_on import adapters, catalogue, credentials, crypto, entitlements, images, selection, storage
from app.services.try_on.adapters.base import GenerationInput
from app.services.try_on.errors import ProviderFailure, describe, sanitize
from app.services.try_on.service import _finish_failed

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 6


def lease_seconds() -> int:
    return max(60, int(settings.VTO_WORKER_LEASE_SECONDS or 300))


def claim(db: Session, now: Optional[datetime] = None) -> Optional[str]:
    """Take the oldest queued request, or None."""
    now = now or datetime.utcnow()
    row = db.execute(
        select(VtoRequest).where(VtoRequest.status == "queued")
        .order_by(VtoRequest.queued_at, VtoRequest.id).limit(1).with_for_update(skip_locked=True)
    ).scalar_one_or_none()
    if row is None:
        return None
    row.status = "processing"
    row.lease_until = now + timedelta(seconds=lease_seconds())
    row.started_at = now
    row.updated_at = now
    db.commit()
    return row.id


def _renew(db: Session, request: VtoRequest, status: str, seconds: int) -> None:
    now = datetime.utcnow()
    request.status = status
    request.lease_until = now + timedelta(seconds=max(lease_seconds(), seconds + 60))
    request.updated_at = now
    db.commit()


def _cancelled(db: Session, request: VtoRequest) -> bool:
    db.refresh(request, attribute_names=["cancel_requested"])
    return bool(request.cancel_requested)


def _fail(db: Session, request: VtoRequest, code: str, detail: str = "", *, retryable: Optional[bool] = None,
          rules: Optional[dict] = None) -> None:
    now = datetime.utcnow()
    failure = describe(code)
    allowed = int((rules or {}).get("retriesPerRequest") or 0)
    can_retry = failure.retryable if retryable is None else retryable
    _finish_failed(request, code, sanitize(detail, 600), now, retryable=can_retry and request.retries_used < allowed)
    entitlements.settle(db, request.id, "failed" if code != "cancelled" else "cancelled")
    if code not in ("cancelled",):
        _notify(db, request, "Your try-on couldn't be created", failure.customer)
    db.commit()


def _notify(db: Session, request: VtoRequest, title: str, body: str) -> None:
    try:
        from app.services import inbox

        inbox.customer(db, request.customer_id, "try-on", title, body, href=f"/account/try-on?request={request.id}")
    except Exception:  # noqa: BLE001 — a notice never breaks the work
        logger.warning("Could not notify the customer about try-on %s", request.id)


def _entitled(db: Session, request: VtoRequest) -> tuple:
    """(still allowed?, rules). The allowance the request was charged to must still exist."""
    customer = db.get(Customer, request.customer_id)
    if customer is None or customer.status != "active":
        return False, {}
    entitlement = entitlements.resolve(db, customer)
    if not entitlement.eligible and request.source != "allocation":
        return False, entitlement.rules
    if request.source == "plan":
        ok = entitlement.source == "plan" and entitlement.membership and entitlement.membership.id == request.membership_id
        return bool(ok), entitlement.rules
    if request.source == "allocation":
        allocation = db.get(VtoAllocation, request.allocation_id) if request.allocation_id else None
        now = datetime.utcnow()
        ok = (allocation is not None and allocation.status == "active" and allocation.starts_at <= now
              and (allocation.ends_at is None or allocation.ends_at > now))
        return ok, entitlement.rules if entitlement.eligible else {**entitlements.DEFAULT_RULES, "enabled": True}
    return entitlement.eligible, entitlement.rules


def _garment(db: Session, request: VtoRequest) -> bytes:
    product = db.get(Product, request.product_id) if request.product_id else None
    if product is None:
        raise ProviderFailure("garment_unavailable", "the product no longer exists")
    last: Optional[ProviderFailure] = None
    for url in catalogue.garment_urls(db, product, request.color)[:3]:
        try:
            return images.fetch_garment(url)
        except ProviderFailure as failure:
            last = failure
    raise last or ProviderFailure("garment_unavailable", "the product has no photos")


def process(db: Session, request_id: str) -> str:
    """Run one claimed request to its end. Returns the final status."""
    request = db.get(VtoRequest, request_id)
    if request is None or request.status not in ("processing", "retrying"):
        return request.status if request else "missing"
    if request.cancel_requested:
        _fail(db, request, "cancelled")
        return request.status

    allowed, rules = _entitled(db, request)
    if not allowed:
        _fail(db, request, "plan_ineligible", "the entitlement the request was charged to has ended", retryable=False)
        return request.status

    photo = db.get(VtoPhoto, request.photo_id) if request.photo_id else None
    person = None
    if photo is not None and photo.deleted_at is None:
        try:
            person = storage.backend(photo.storage).get(photo.object_key)
        except storage.StorageFailed as error:
            _fail(db, request, "storage_unavailable", f"photo could not be read ({error})", rules=rules)
            return request.status
    if person is None:
        _fail(db, request, "invalid_image", "the customer's photo is no longer available", retryable=False)
        return request.status
    try:
        garment = _garment(db, request)
    except ProviderFailure as failure:
        _fail(db, request, failure.code, failure.detail, rules=rules)
        return request.status

    found = selection.candidates(db, request, quality_tiers=rules.get("qualityTiers") or None)
    if not found:
        _fail(db, request, "no_capacity", "no eligible model and credential", rules=rules)
        return request.status

    budget = min(MAX_ATTEMPTS, 1 + max(int(found[0].provider.max_retries or 0), 0))
    skip_models, skip_providers = set(), set()
    last: Optional[ProviderFailure] = None
    output = None
    used = None
    tried = 0
    for candidate in found:
        if tried >= budget:
            break
        if candidate.model.id in skip_models or candidate.provider.id in skip_providers:
            continue
        if _cancelled(db, request):
            _fail(db, request, "cancelled")
            return request.status
        tried += 1
        timeout = max(10, int(candidate.provider.timeout_seconds or 120))
        _renew(db, request, "processing" if tried == 1 else "retrying", timeout)
        try:
            adapter = adapters.get(candidate.model.adapter_key)
        except KeyError:
            skip_models.add(candidate.model.id)
            continue
        credential: Optional[VtoCredential] = candidate.credential
        secret = crypto.unseal(credential.secret_sealed) if credential is not None else None
        started = datetime.utcnow()
        clock = time.monotonic()
        failure: Optional[ProviderFailure] = None
        try:
            result = adapter.generate(
                GenerationInput(request.capability_key, person, garment, request.id),
                secret=secret, config=candidate.model.config or {}, timeout=timeout,
            )
            try:
                checked = images.normalise(result.data, max_bytes=images.HARD_MAX_BYTES)
            except Exception as error:  # noqa: BLE001 — anything but an image is a bad answer
                raise ProviderFailure("bad_provider_response", f"the answer is not a usable image ({error})") from None
        except Exception as error:  # noqa: BLE001 — classified, recorded, and the next candidate tried
            failure = adapter.classify(error)
        finished = datetime.utcnow()
        latency = int((time.monotonic() - clock) * 1000)
        request.attempts += 1
        db.add(VtoAttempt(
            request_id=request.id, number=request.attempts, provider_id=candidate.provider.id,
            model_id=candidate.model.id, credential_id=credential.id if credential else "",
            credential_label=credential.label if credential else "", outcome="failed" if failure else "succeeded",
            error_code=failure.code if failure else "", technical_detail=failure.detail if failure else "",
            latency_ms=latency, started_at=started, finished_at=finished,
        ))
        credentials.record_outcome(db, credential, failure, candidate.provider)
        request.provider_id, request.model_id = candidate.provider.id, candidate.model.id
        request.credential_id = credential.id if credential else None
        request.credential_label = credential.label if credential else ""
        if failure is None:
            output, used = checked, candidate
            # A running average, so waiting times shown to customers follow reality.
            candidate.model.avg_seconds = max(5, int(0.8 * candidate.model.avg_seconds + 0.2 * latency / 1000))
            db.commit()
            break
        last = failure
        db.commit()
        scope = failure.failure.scope
        if scope == "request":
            break
        if scope in ("model", "system"):
            skip_models.add(candidate.model.id)
        elif scope == "provider":
            skip_providers.add(candidate.provider.id)

    if output is None:
        last = last or ProviderFailure("no_capacity", "no candidate could be tried")
        _fail(db, request, last.code, last.detail, rules=rules)
        return request.status

    if _cancelled(db, request):
        _fail(db, request, "cancelled")
        return request.status
    _store(db, request, output.data, rules, photo)
    return request.status


def _store(db: Session, request: VtoRequest, data: bytes, rules: dict, photo: Optional[VtoPhoto]) -> None:
    now = datetime.utcnow()
    preferred = storage.active_name() or "ephemeral"
    mode = "ephemeral" if preferred == "ephemeral" else rules.get("retention", "temporary")
    key = storage.new_key("results", request.customer_id)
    stored_in = None
    for name in dict.fromkeys((preferred, "ephemeral")):
        try:
            backend = storage.backend(name)
            object_key = key if name == preferred else key.split("/", 1)[-1] if name == "ephemeral" else key
            backend.put(object_key, data, "image/jpeg")
            stored_in, key = name, object_key
            break
        except storage.StorageFailed as error:
            logger.warning("Try-on %s: could not store the result in %s (%s)", request.id, name, error)
    if stored_in is None:
        _fail(db, request, "storage_unavailable", "the result could not be stored anywhere", rules=rules)
        return
    if stored_in != preferred:
        mode = "ephemeral"
        request.technical_detail = "Stored temporarily: the configured storage failed."[:600]

    request.status = "succeeded"
    request.storage_mode = mode
    request.result_storage, request.result_key, request.result_content_type = stored_in, key, "image/jpeg"
    request.result_expires_at = storage.expires_for(stored_in, mode, rules.get("retentionDays"), now)
    request.error_code = request.error_badge = request.error_message = ""
    request.retryable, request.lease_until = False, None
    request.finished_at, request.updated_at = now, now
    if request.started_at:
        request.duration_ms = int((now - request.started_at).total_seconds() * 1000)
    # The original stays as long as the result, for the before-and-after view.
    if photo is not None and not photo.saved:
        photo.expires_at = None if request.result_expires_at is None else max(
            photo.expires_at or now, request.result_expires_at)
    entitlements.settle(db, request.id, "succeeded")
    _notify(db, request, "Your try-on is ready", f"See how {request.product_name} looks on you.")
    db.commit()
    _usage_warning(db, request)


def _usage_warning(db: Session, request: VtoRequest) -> None:
    """Tell the customer once a period when they've used most of their allowance."""
    from app.services.try_on import programme

    try:
        customer = db.get(Customer, request.customer_id)
        summary = entitlements.summary(db, customer)
        limit, remaining = summary.get("perPeriod"), summary.get("remaining")
        if not limit or remaining is None:
            return
        threshold = programme.get(db)["usageWarningPercent"]
        used = limit - remaining
        if remaining == 0:
            title, body = "You've used all your try-ons", "Your allowance renews soon — or ask us for more."
        elif used * 100 >= threshold * limit:
            title, body = "You're running low on try-ons", f"{remaining} of {limit} left this period."
        else:
            return
        _notify(db, request, title, body)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.warning("Could not check try-on usage for %s", request.customer_id)


def drain(db: Session, limit: int = 20) -> int:
    """Claim and run queued requests one after another — for tests and the portal's 'run now'."""
    count = 0
    for _ in range(limit):
        request_id = claim(db)
        if request_id is None:
            break
        try:
            process(db, request_id)
        except Exception:  # noqa: BLE001
            db.rollback()
            logger.exception("Try-on %s failed unexpectedly", request_id)
            row = db.get(VtoRequest, request_id)
            if row is not None and row.status in entitlements.ACTIVE_STATUSES:
                _fail(db, row, "unknown", "the worker failed unexpectedly")
        count += 1
    return count


# ---------------------------------------------------------------- the loop


def _session():
    from app.core.database import SessionLocal

    return SessionLocal()


def _close(db) -> None:
    if not db.info.get("test_session"):
        db.close()


def _claim_once() -> Optional[str]:
    db = _session()
    try:
        return claim(db)
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Could not claim a try-on request")
        return None
    finally:
        _close(db)


def _run_once(request_id: str) -> None:
    db = _session()
    try:
        process(db, request_id)
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Try-on %s failed unexpectedly", request_id)
        try:
            row = db.get(VtoRequest, request_id)
            if row is not None and row.status in entitlements.ACTIVE_STATUSES:
                _fail(db, row, "unknown", "the worker failed unexpectedly")
        except Exception:  # noqa: BLE001
            db.rollback()
    finally:
        _close(db)


async def run_forever() -> None:
    """Keep up to VTO_WORKER_CONCURRENCY generations running from the queue."""
    concurrency = max(1, int(settings.VTO_WORKER_CONCURRENCY or 1))
    poll = max(1, int(settings.VTO_WORKER_POLL_SECONDS or 2))
    slots = asyncio.Semaphore(concurrency)
    running: set = set()
    logger.info("Virtual try-on worker: %s at a time.", concurrency)

    async def run(request_id: str) -> None:
        try:
            await asyncio.to_thread(_run_once, request_id)
        finally:
            slots.release()

    while True:
        try:
            await slots.acquire()
            request_id = await asyncio.to_thread(_claim_once)
            if request_id is None:
                slots.release()
                await asyncio.sleep(poll)
                continue
            task = asyncio.create_task(run(request_id))
            running.add(task)
            task.add_done_callback(running.discard)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("The try-on worker stumbled; carrying on.")
            await asyncio.sleep(poll)
