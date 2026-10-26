"""
Try-on housekeeping, every VTO_HOUSEKEEPING_INTERVAL_SECONDS:

- **expired results and photos** are deleted from storage (temporary
  retention, ephemeral TTL, unsaved photos nobody used);
- **ephemeral working files** older than the TTL are removed whatever the
  database says, so nothing lingers on the server;
- **failed deletions** are retried with backoff until storage confirms them;
- **stale requests** — claimed by a process that stopped — are put back in
  the queue once, then failed;
- **lapsed members' "permanent" results** turn temporary after the grace
  period, so a membership ending doesn't keep images forever;
- **rate-limited credentials** whose rest is over are made usable again;
- **allocations** past their end are marked expired;
- **credentials** are health-checked about once a day;
- **reminders** go out before temporary results are deleted.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import (
    CustomerMembership,
    VtoAllocation,
    VtoCleanupTask,
    VtoCredential,
    VtoPhoto,
    VtoRequest,
)
from app.services.try_on import entitlements, programme, storage
from app.services.try_on.service import discard

logger = logging.getLogger(__name__)

BATCH = 200
HEALTH_EVERY = timedelta(hours=24)


def expire_results(db: Session, now: datetime) -> int:
    rows = db.execute(select(VtoRequest).where(
        VtoRequest.result_expires_at.is_not(None), VtoRequest.result_expires_at <= now,
        VtoRequest.result_deleted_at.is_(None), VtoRequest.result_key != "",
    ).limit(BATCH)).scalars().all()
    for request in rows:
        discard(db, request.result_storage, request.result_key, "expired")
        request.result_deleted_at = now
        if request.status == "succeeded":
            request.status = "expired"
        request.updated_at = now
    return len(rows)


def expire_photos(db: Session, now: datetime) -> int:
    rows = db.execute(select(VtoPhoto).where(
        VtoPhoto.deleted_at.is_(None), VtoPhoto.expires_at.is_not(None), VtoPhoto.expires_at <= now,
    ).limit(BATCH)).scalars().all()
    removed = 0
    for photo in rows:
        busy = db.execute(select(VtoRequest.id).where(
            VtoRequest.photo_id == photo.id, VtoRequest.status.in_(entitlements.ACTIVE_STATUSES)).limit(1)).first()
        if busy:
            continue
        discard(db, photo.storage, photo.object_key, "expired" if photo.saved else "abandoned")
        photo.deleted_at = now
        removed += 1
    return removed


def retry_cleanup(db: Session, now: datetime) -> dict:
    rows = db.execute(select(VtoCleanupTask).where(
        VtoCleanupTask.done_at.is_(None), VtoCleanupTask.next_attempt_at <= now,
    ).order_by(VtoCleanupTask.next_attempt_at).limit(BATCH)).scalars().all()
    done = failed = 0
    for task in rows:
        task.attempts += 1
        try:
            storage.backend(task.storage).delete(task.object_key)
            task.done_at, task.last_error = now, ""
            done += 1
        except storage.StorageFailed as error:
            task.last_error = str(error)[:300]
            # 5 min, 10, 20, 40… up to a day.
            task.next_attempt_at = now + timedelta(minutes=min(5 * 2 ** min(task.attempts, 9), 1440))
            failed += 1
    return {"done": done, "failed": failed}


def requeue_stale(db: Session, now: datetime) -> int:
    from app.services.try_on.worker import _fail

    rows = db.execute(select(VtoRequest).where(
        VtoRequest.status.in_(("processing", "retrying")), VtoRequest.lease_until.is_not(None),
        VtoRequest.lease_until < now,
    ).limit(BATCH)).scalars().all()
    for request in rows:
        if "lease_requeued" not in (request.notices or []):
            request.status, request.lease_until = "queued", None
            request.notices = [*(request.notices or []), "lease_requeued"]
            request.updated_at = now
        else:
            _fail(db, request, "lease_lost", "the worker running it stopped twice")
    return len(rows)


def lapse_permanent(db: Session, now: datetime) -> int:
    """Results kept 'permanently' under a membership that has ended get the grace period, then go."""
    grace = programme.get(db)["lapsedGraceDays"]
    rows = db.execute(select(VtoRequest).where(
        VtoRequest.storage_mode == "permanent", VtoRequest.result_expires_at.is_(None),
        VtoRequest.result_deleted_at.is_(None), VtoRequest.status == "succeeded",
        VtoRequest.membership_id.is_not(None),
    ).limit(BATCH)).scalars().all()
    changed = 0
    for request in rows:
        membership = db.get(CustomerMembership, request.membership_id)
        if membership is None:
            continue
        current = entitlements.memberships.active_membership(db, request.customer_id, now)
        if current is not None and entitlements.plan_rules(db, current) and \
                entitlements.plan_rules(db, current).get("retention") == "permanent":
            continue
        if membership.status in ("expired", "cancelled") or (membership.ends_at and membership.ends_at <= now):
            request.storage_mode = "temporary"
            request.result_expires_at = now + timedelta(days=grace)
            request.updated_at = now
            changed += 1
    return changed


def refresh_credentials(db: Session, now: datetime) -> dict:
    from app.services.try_on import credentials

    revived = 0
    for row in db.execute(select(VtoCredential).where(
            VtoCredential.status == "rate_limited", VtoCredential.cooldown_until <= now)).scalars():
        row.status, row.cooldown_until = "active", None
        revived += 1
    checked = 0
    due = now - HEALTH_EVERY
    for row in db.execute(select(VtoCredential).where(
            VtoCredential.deleted_at.is_(None), VtoCredential.status.in_(("active", "invalid")),
            (VtoCredential.last_validated_at.is_(None)) | (VtoCredential.last_validated_at < due),
    ).limit(10)).scalars().all():
        try:
            credentials.validate(db, row.id)
            checked += 1
        except Exception:  # noqa: BLE001 — one bad credential never stops the pass
            logger.warning("Could not health-check credential %s", row.id)
    return {"revived": revived, "checked": checked}


def expire_allocations(db: Session, now: datetime) -> int:
    rows = db.execute(select(VtoAllocation).where(
        VtoAllocation.status == "active", VtoAllocation.ends_at.is_not(None), VtoAllocation.ends_at <= now,
    )).scalars().all()
    for allocation in rows:
        allocation.status, allocation.updated_at = "expired", now
    return len(rows)


def remind_retention(db: Session, now: datetime) -> int:
    from app.services import inbox

    days = programme.get(db)["retentionReminderDays"]
    if not days:
        return 0
    rows = db.execute(select(VtoRequest).where(
        VtoRequest.status == "succeeded", VtoRequest.storage_mode == "temporary",
        VtoRequest.result_deleted_at.is_(None), VtoRequest.deleted_at.is_(None),
        VtoRequest.result_expires_at.is_not(None), VtoRequest.result_expires_at > now,
        VtoRequest.result_expires_at <= now + timedelta(days=days),
    ).limit(BATCH)).scalars().all()
    sent = 0
    for request in rows:
        if "retention_reminder" in (request.notices or []):
            continue
        inbox.customer(db, request.customer_id, "try-on", "A try-on will be deleted soon",
                       f"Your try-on of {request.product_name} is kept until "
                       f"{request.result_expires_at:%d %b}. Download it before then if you'd like to keep it.",
                       href=f"/account/try-on?request={request.id}")
        request.notices = [*(request.notices or []), "retention_reminder"]
        sent += 1
    return sent


def sweep(db: Session, now: datetime | None = None) -> dict:
    now = now or datetime.utcnow()
    result = {
        "results": expire_results(db, now),
        "photos": expire_photos(db, now),
        "stale": requeue_stale(db, now),
        "lapsed": lapse_permanent(db, now),
        "allocations": expire_allocations(db, now),
        "reminders": remind_retention(db, now),
    }
    db.commit()
    result["cleanup"] = retry_cleanup(db, now)
    db.commit()
    result["credentials"] = refresh_credentials(db, now)
    db.commit()
    try:
        result["workingFiles"] = storage.backend("ephemeral").sweep()
    except Exception:  # noqa: BLE001
        result["workingFiles"] = 0
    return result


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            result = sweep(db)
            if result and any(v for v in result.values() if isinstance(v, int)):
                logger.info("Try-on housekeeping: %s", result)
        except Exception:  # noqa: BLE001 — logged; the next pass tries again
            db.rollback()
            logger.exception("Try-on housekeeping failed; retrying next interval.")


async def run_forever() -> None:
    import asyncio

    interval = max(60, int(settings.VTO_HOUSEKEEPING_INTERVAL_SECONDS or 300))
    logger.info("Try-on housekeeping every %ss.", interval)
    while True:
        try:
            from app.services import jobs

            await asyncio.to_thread(jobs.tracked("try_on", interval, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Try-on housekeeping failed; retrying next interval.")
        await asyncio.sleep(interval)
