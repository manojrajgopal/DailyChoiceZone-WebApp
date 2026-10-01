"""
System health: is each part of the shop working?

Each check returns one of four statuses — **healthy**, **degraded** (working,
but something needs attention), **unhealthy** (broken) or **unknown** (it
couldn't be checked, or hasn't run yet) — with a plain-language message.
The overall status is the worst of them, except that *unknown* alone never
makes the shop look broken.

## What is never shown

Passwords, keys, tokens, connection strings, hostnames and file paths. A check
says "the payment keys are set", never what they are; "the database answered
in 4 ms", never where it is. The public endpoints (`/health/live`,
`/health/ready`) say only whether the server can take traffic; the detail is
for administrators with the `health` permission.

## History and alerts

`run_forever` checks every five minutes and keeps a snapshot (two weeks of
them). When the overall status becomes unhealthy, the store team is told once
(admin tray and email); when it recovers, they're told that too.
"""

from __future__ import annotations

import logging
import os
import platform
import shutil
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import EmailLog, HealthSnapshot, JobHeartbeat, WebhookEvent

logger = logging.getLogger(__name__)

HEALTHY, DEGRADED, UNHEALTHY, UNKNOWN = "healthy", "degraded", "unhealthy", "unknown"
RANK = {HEALTHY: 0, UNKNOWN: 1, DEGRADED: 2, UNHEALTHY: 3}
INTERVAL_SECONDS = 300
KEEP_DAYS = 14
STARTED_AT = datetime.utcnow()
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _result(status: str, message: str, *, latency_ms: Optional[int] = None, **facts) -> dict:
    out = {"status": status, "message": message}
    if latency_ms is not None:
        out["latencyMs"] = latency_ms
    if facts:
        out["facts"] = facts
    return out


def _timed(fn):
    start = time.monotonic()
    value = fn()
    return value, int((time.monotonic() - start) * 1000)


# ------------------------------------------------------------------ checks


def check_database(db: Session) -> dict:
    try:
        _, ms = _timed(lambda: db.execute(text("SELECT 1")).scalar())
    except Exception:  # noqa: BLE001 — the reason is logged, not shown
        logger.exception("Health check: database unreachable")
        return _result(UNHEALTHY, "The database isn't answering.")
    if ms > 1000:
        return _result(DEGRADED, f"The database is slow to answer ({ms} ms).", latency_ms=ms)
    return _result(HEALTHY, f"The database answered in {ms} ms.", latency_ms=ms)


def _heads() -> List[str]:
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    config = Config(os.path.join(BACKEND_DIR, "alembic.ini"))
    config.set_main_option("script_location", os.path.join(BACKEND_DIR, "alembic"))
    return list(ScriptDirectory.from_config(config).get_heads())


def check_migrations(db: Session) -> dict:
    try:
        current = db.execute(text("SELECT version_num FROM alembic_version")).scalars().all()
        heads = _heads()
    except Exception:  # noqa: BLE001
        logger.warning("Health check: could not read the schema version", exc_info=True)
        return _result(UNKNOWN, "The schema version couldn't be read.")
    if set(current) == set(heads):
        return _result(HEALTHY, "The database schema is up to date.")
    return _result(DEGRADED, "The database schema is behind the application — a migration hasn't been applied.")


def check_payments(db: Session, *, deep: bool = False) -> dict:
    provider = (settings.PAYMENT_PROVIDER or "").lower()
    since = datetime.utcnow() - timedelta(hours=24)
    failed = db.execute(select(func.count()).select_from(WebhookEvent).where(
        WebhookEvent.status == "failed", WebhookEvent.received_at >= since)).scalar_one()
    last = db.execute(select(func.max(WebhookEvent.received_at))).scalar_one()
    facts = {"provider": provider or "none", "failedWebhooks24h": int(failed), "lastWebhookAt": last}
    if provider == "mock":
        status = DEGRADED if settings.is_production else HEALTHY
        return _result(status, "Test payments (mock provider): no real money is taken.", **facts)
    if provider != "razorpay":
        return _result(UNKNOWN, "No payment provider is configured.", **facts)
    if not settings.razorpay_configured:
        return _result(UNHEALTHY, "Razorpay is selected but its keys are not set.", **facts)
    facts["mode"] = "live" if settings.razorpay_live else "test"
    facts["webhookSecretSet"] = bool(settings.RAZOR_WEBHOOK_SECRET)
    latency = None
    if deep:
        ok, latency = _ping_razorpay()
        if not ok:
            return _result(UNHEALTHY, "Razorpay didn't accept a request with the configured keys.",
                           latency_ms=latency, **facts)
    if not settings.RAZOR_WEBHOOK_SECRET:
        return _result(DEGRADED, "The Razorpay webhook secret is not set, so payment updates can't be verified.",
                       latency_ms=latency, **facts)
    if failed:
        return _result(DEGRADED, f"{failed} payment webhook{'s' if failed != 1 else ''} failed in the last 24 hours.",
                       latency_ms=latency, **facts)
    return _result(HEALTHY, "Razorpay is configured" + (" and answering." if deep else "."), latency_ms=latency,
                   **facts)


def _ping_razorpay() -> tuple:
    """One authenticated read against Razorpay. Keys go in the header; nothing is logged."""
    import base64
    import urllib.request

    token = base64.b64encode(f"{settings.RAZOR_KEY_ID}:{settings.RAZOR_KEY_SECRET}".encode()).decode()
    request = urllib.request.Request("https://api.razorpay.com/v1/orders?count=1",
                                     headers={"Authorization": f"Basic {token}"})
    start = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=5) as response:  # noqa: S310 — fixed https URL
            ok = response.status == 200
    except Exception:  # noqa: BLE001
        ok = False
    return ok, int((time.monotonic() - start) * 1000)


def check_email(db: Session) -> dict:
    from app.services import email as email_service

    account = email_service.active_account(db)
    since = datetime.utcnow() - timedelta(hours=24)
    rows = dict(db.execute(select(EmailLog.status, func.count()).where(EmailLog.created_at >= since)
                           .group_by(EmailLog.status)).all())
    sent, failed = int(rows.get("sent", 0)), int(rows.get("failed", 0))
    bounced = db.execute(select(func.count()).select_from(EmailLog).where(EmailLog.bounced_at >= since)).scalar_one()
    facts = {"sent24h": sent, "failed24h": failed, "bounced24h": int(bounced),
             "provider": account.provider if account else None}
    if account is None:
        return _result(DEGRADED, "No sending account is connected, so no emails are going out.", **facts)
    total = sent + failed
    if total >= 5 and failed / total >= 0.5:
        return _result(UNHEALTHY, f"{failed} of {total} emails failed to send in the last 24 hours.", **facts)
    if failed:
        return _result(DEGRADED, f"{failed} of {total} emails failed to send in the last 24 hours.", **facts)
    return _result(HEALTHY, f"Sending account connected; {sent} email{'s' if sent != 1 else ''} sent in the last 24 hours.",
                   **facts)


def check_storage(*, deep: bool = False) -> dict:
    from app.services import storage

    if not storage.is_configured():
        return _result(DEGRADED, "File storage isn't configured, so image uploads are switched off.")
    if deep:
        try:
            client = storage._client(settings.AWS_ACCESS_KEY_ID, settings.AWS_SECRET_ACCESS_KEY, settings.AWS_REGION,
                                     settings.AWS_S3_ENDPOINT_URL or None)
            _, ms = _timed(lambda: client.head_bucket(Bucket=settings.AWS_S3_BUCKET))
        except Exception:  # noqa: BLE001
            logger.warning("Health check: storage unreachable", exc_info=True)
            return _result(UNHEALTHY, "The file storage bucket couldn't be reached.")
        return _result(HEALTHY, f"File storage answered in {ms} ms.", latency_ms=ms)
    return _result(HEALTHY, "File storage is configured.")


def check_disk() -> dict:
    try:
        usage = shutil.disk_usage(BACKEND_DIR)
    except OSError:
        return _result(UNKNOWN, "Disk space couldn't be read.")
    free = usage.free / usage.total * 100 if usage.total else 0
    facts = {"freePercent": round(free, 1), "freeGb": round(usage.free / 1024 ** 3, 1)}
    if free < 5:
        return _result(UNHEALTHY, f"The server's disk is almost full ({free:.0f}% free).", **facts)
    if free < 10:
        return _result(DEGRADED, f"The server's disk is getting full ({free:.0f}% free).", **facts)
    return _result(HEALTHY, f"{free:.0f}% of the server's disk is free.", **facts)


def check_jobs(db: Session, now: Optional[datetime] = None) -> dict:
    from app.services.jobs import EXPECTED

    now = now or datetime.utcnow()
    beats = {row.name: row for row in db.execute(select(JobHeartbeat)).scalars()}
    jobs, worst = [], HEALTHY
    for name, label in EXPECTED.items():
        row = beats.get(name)
        if name == "payment_expiry" and (settings.PAYMENT_PROVIDER or "").lower() == "mock":
            status, message = HEALTHY, "Not needed with test payments."
        elif row is None or row.last_started_at is None:
            status, message = UNKNOWN, "Hasn't run yet."
        elif row.consecutive_failures >= 3:
            status, message = UNHEALTHY, f"Failed {row.consecutive_failures} times in a row."
        elif row.last_success_at is None or row.last_success_at < now - timedelta(
                seconds=row.interval_seconds * 3 + 120):
            status, message = DEGRADED, "Hasn't completed a run recently."
        elif row.consecutive_failures:
            status, message = DEGRADED, "Its last run failed."
        else:
            status, message = HEALTHY, "Running on schedule."
        if RANK[status] > RANK[worst]:
            worst = status
        jobs.append({
            "name": name, "label": label, "status": status, "message": message,
            "intervalSeconds": row.interval_seconds if row else None,
            "lastSuccessAt": row.last_success_at if row else None,
            "lastStartedAt": row.last_started_at if row else None,
            "lastDurationMs": row.last_duration_ms if row else None,
            "runs": row.runs if row else 0, "failures": row.failures if row else 0,
            # The error's type and message, never a traceback.
            "lastError": (row.last_error or None) if row else None,
            "lastErrorAt": row.last_error_at if row else None,
        })
    counts = {s: sum(1 for j in jobs if j["status"] == s) for s in RANK}
    message = ("Every background job is running on schedule." if worst == HEALTHY else
               f"{counts[UNHEALTHY]} failing, {counts[DEGRADED]} late, {counts[UNKNOWN]} not run yet.")
    return {**_result(worst, message), "jobs": jobs}


def check_application() -> dict:
    uptime = int((datetime.utcnow() - STARTED_AT).total_seconds())
    return _result(HEALTHY, "The application is running.", version="1.0.0", environment=settings.ENVIRONMENT,
                   python=platform.python_version(), uptimeSeconds=uptime, startedAt=STARTED_AT)


def check_backups(db: Session) -> dict:
    from app.models import DatabaseBackup
    from app.services import backups

    conf = backups.settings_doc(db)
    last = db.execute(select(DatabaseBackup).where(DatabaseBackup.status.in_(("succeeded", "failed")))
                      .order_by(DatabaseBackup.started_at.desc()).limit(1)).scalar_one_or_none()
    good = db.execute(select(func.max(DatabaseBackup.completed_at)).where(DatabaseBackup.status == "succeeded")).scalar()
    facts = {"lastSuccessAt": good, "schedule": conf["frequency"] if conf["enabled"] else "off",
             "encrypted": bool(settings.BACKUP_ENCRYPTION_KEY)}
    if not conf["enabled"]:
        return _result(DEGRADED, "Automatic backups are switched off.", **facts)
    if last is None:
        return _result(UNKNOWN, "No backup has run yet.", **facts)
    if last.status == "failed":
        return _result(UNHEALTHY, "The last backup failed. See Backups for the reason.", **facts)
    allowed = timedelta(hours=backups.FREQUENCIES[conf["frequency"]] * 1.5 + 1)
    if good is None or good < datetime.utcnow() - allowed:
        return _result(DEGRADED, "The last good backup is older than the schedule allows.", **facts)
    return _result(HEALTHY, "The last backup succeeded and was verified.", **facts)


def check_messaging(db: Session) -> dict:
    from app.models import NotificationDelivery
    from app.services.messaging import service as messaging

    status = messaging.channel_status(db)
    since = datetime.utcnow() - timedelta(hours=24)
    dead = db.execute(select(func.count()).select_from(NotificationDelivery).where(
        NotificationDelivery.status == "dead", NotificationDelivery.updated_at >= since)).scalar_one()
    retrying = db.execute(select(func.count()).select_from(NotificationDelivery).where(
        NotificationDelivery.status == "failed")).scalar_one()
    misconfigured = [c for c in ("sms", "whatsapp") if status[c]["enabled"] and not status[c]["configured"]]
    facts = {"sms": "on" if status["sms"]["enabled"] else ("ready" if status["sms"]["configured"] else "not set up"),
             "whatsapp": "on" if status["whatsapp"]["enabled"] else (
                 "ready" if status["whatsapp"]["configured"] else "not set up"),
             "gaveUp24h": int(dead), "retrying": int(retrying)}
    if misconfigured:
        return _result(DEGRADED, f"{', '.join(misconfigured)} is switched on but its provider isn't configured.", **facts)
    if dead:
        return _result(DEGRADED, f"{dead} message{'s' if dead != 1 else ''} couldn't be delivered in the last 24 hours.",
                       **facts)
    return _result(HEALTHY, "Messages are going out" + (f"; {retrying} waiting to retry." if retrying else "."), **facts)


LABELS = {
    "backups": "Database backups", "messaging": "SMS & WhatsApp",
    "database": "Database", "migrations": "Database schema", "payments": "Payments", "email": "Email",
    "storage": "File storage", "disk": "Disk space", "jobs": "Background jobs", "application": "Application",
}
# A broken database is the shop down; everything else degrades it.
CRITICAL = {"database"}


def overall(checks: Dict[str, dict]) -> str:
    worst = HEALTHY
    for name, check in checks.items():
        status = check["status"]
        if status == UNHEALTHY and name not in CRITICAL:
            status = DEGRADED if name not in ("payments", "jobs") else UNHEALTHY
        if status == UNKNOWN:
            continue
        if RANK[status] > RANK[worst]:
            worst = status
    if checks.get("database", {}).get("status") == UNHEALTHY:
        return UNHEALTHY
    return worst


def run(db: Session, *, deep: bool = False) -> dict:
    """Every check. `deep` also calls Razorpay and the storage bucket."""
    start = time.monotonic()
    checks: Dict[str, dict] = {"database": check_database(db)}
    database_up = checks["database"]["status"] != UNHEALTHY
    for name, fn in (
        ("migrations", lambda: check_migrations(db)),
        ("payments", lambda: check_payments(db, deep=deep)),
        ("email", lambda: check_email(db)),
        ("jobs", lambda: check_jobs(db)),
        ("backups", lambda: check_backups(db)),
        ("messaging", lambda: check_messaging(db)),
    ):
        if not database_up:
            checks[name] = _result(UNKNOWN, "Can't be checked while the database is down.")
            continue
        try:
            checks[name] = fn()
        except Exception:  # noqa: BLE001
            logger.exception("Health check %s failed", name)
            db.rollback()
            checks[name] = _result(UNKNOWN, "This check couldn't run.")
    checks["storage"] = check_storage(deep=deep)
    checks["disk"] = check_disk()
    checks["application"] = check_application()
    for name, check in checks.items():
        check["label"] = LABELS[name]
    return {"status": overall(checks), "checkedAt": datetime.utcnow(), "deep": deep,
            "durationMs": int((time.monotonic() - start) * 1000), "checks": checks}


# ----------------------------------------------------------------- probes


def liveness() -> dict:
    return {"status": "alive", "uptimeSeconds": int((datetime.utcnow() - STARTED_AT).total_seconds())}


def readiness(db: Session) -> tuple:
    """Ready to take traffic: the database answers and the schema is current. (ready, payload)"""
    database = check_database(db)
    migrations = check_migrations(db) if database["status"] != UNHEALTHY else _result(UNKNOWN, "")
    ready = database["status"] != UNHEALTHY and migrations["status"] != DEGRADED
    return ready, {"status": "ready" if ready else "not-ready",
                   "database": database["status"], "schema": migrations["status"]}


# --------------------------------------------------------------- history


def snapshot(db: Session, result: dict) -> HealthSnapshot:
    compact = {name: {"status": c["status"], "message": c["message"], "latencyMs": c.get("latencyMs")}
               for name, c in result["checks"].items()}
    row = HealthSnapshot(checked_at=result["checkedAt"], status=result["status"], checks=compact,
                         duration_ms=result["durationMs"])
    db.add(row)
    return row


def history(db: Session, *, hours: int = 24) -> List[dict]:
    since = datetime.utcnow() - timedelta(hours=hours)
    rows = db.execute(select(HealthSnapshot).where(HealthSnapshot.checked_at >= since)
                      .order_by(HealthSnapshot.checked_at)).scalars().all()
    return [{"checkedAt": r.checked_at, "status": r.status, "durationMs": r.duration_ms,
             "problems": {k: v["status"] for k, v in (r.checks or {}).items() if v.get("status") != HEALTHY}}
            for r in rows]


def uptime(db: Session, *, days: int = 7) -> Optional[float]:
    since = datetime.utcnow() - timedelta(days=days)
    rows = dict(db.execute(select(HealthSnapshot.status, func.count()).where(HealthSnapshot.checked_at >= since)
                           .group_by(HealthSnapshot.status)).all())
    total = sum(rows.values())
    if not total:
        return None
    return round((total - rows.get(UNHEALTHY, 0)) / total * 100, 2)


def record_and_alert(db: Session, result: dict) -> None:
    """Keep the snapshot; tell the team when the shop becomes unhealthy, or recovers."""
    from app.services import inbox

    previous = db.execute(select(HealthSnapshot.status).order_by(HealthSnapshot.checked_at.desc(),
                                                                 HealthSnapshot.id.desc()).limit(1)).scalar_one_or_none()
    snapshot(db, result)
    status = result["status"]
    if status == UNHEALTHY and previous != UNHEALTHY:
        broken = [c["label"] + ": " + c["message"] for c in result["checks"].values() if c["status"] == UNHEALTHY]
        inbox.staff(db, "health", "System health: something is broken", " ".join(broken)[:480],
                    "/admin/health", permission="health")
    elif previous == UNHEALTHY and status != UNHEALTHY:
        inbox.staff(db, "health", "System health: recovered", "Every critical check is working again.",
                    "/admin/health", permission="health")
    db.execute(HealthSnapshot.__table__.delete().where(
        HealthSnapshot.checked_at < datetime.utcnow() - timedelta(days=KEEP_DAYS)))
    db.commit()


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            record_and_alert(db, run(db))
        except Exception:
            db.rollback()
            raise


async def run_forever() -> None:
    import asyncio

    from app.services import jobs

    logger.info("Health checked every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("health", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Health check failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
