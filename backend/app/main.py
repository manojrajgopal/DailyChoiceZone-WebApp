"""Daily Choice Zone API."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import all_routers
from app.core.config import settings
from app.core.errors import register_error_handlers
from app.core.startup import prepare_database

logging.basicConfig(
    level=logging.INFO if settings.DEBUG else logging.WARNING,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("app")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """
    Get the database ready, then serve.

    Everything happens before the first request rather than lazily on one, so a
    misconfiguration is a startup failure with a readable message instead of a
    500 somebody hits in the middle of checking out.
    """
    if settings.is_production:
        problems = settings.validate_production()
        if problems:
            raise RuntimeError(
                "Refusing to start in production with these settings:\n  - "
                + "\n  - ".join(problems)
            )

    prepare_database()
    logger.info("%s ready at %s", settings.APP_NAME, settings.API_PREFIX)

    # Unpaid orders hold stock for a few minutes; this is what gives it back
    # when nobody pays. Only needed where a real gateway can leave a payment
    # pending — the mock settles on the spot.
    sweeper = None
    if settings.PAYMENT_PROVIDER != "mock":
        from app.services import payment_expiry

        sweeper = asyncio.create_task(payment_expiry.run_forever())

    # Support SLAs, escalation rules and auto-closing resolved tickets.
    from app.services.support import sla as support_sla

    support_sweeper = asyncio.create_task(support_sla.run_forever())

    # Emails the provider accepted but could not deliver: read the bounce
    # notices and mark those emails failed, with the reason.
    from app.services.email import bounces as email_bounces

    bounce_sweeper = asyncio.create_task(email_bounces.run_forever())

    # Bags left behind: mark them, send the reminders, count what comes back.
    from app.services import cart_recovery

    cart_sweeper = asyncio.create_task(cart_recovery.run_forever())

    # Back-in-stock and price-drop alerts that are due; and reward points
    # becoming spendable or expiring, and gift cards expiring.
    from app.services import alerts, loyalty

    alert_sweeper = asyncio.create_task(alerts.run_forever())
    rewards_sweeper = asyncio.create_task(loyalty.run_forever())

    # Flash sales going live, referrals running out of time, and the health
    # check that keeps the history and tells the team when something breaks.
    from app.services import flash_sales, health as health_service, referrals

    flash_sweeper = asyncio.create_task(flash_sales.run_forever())
    referral_sweeper = asyncio.create_task(referrals.run_forever())
    health_sweeper = asyncio.create_task(health_service.run_forever())

    # Messages on every channel (and their retries), campaigns, and backups.
    from app.services import backups
    from app.services.messaging import campaigns, service as messaging

    message_sweeper = asyncio.create_task(messaging.run_forever())
    campaign_sweeper = asyncio.create_task(campaigns.run_forever())
    backup_sweeper = asyncio.create_task(backups.run_forever())

    try:
        yield
    finally:
        for task in (sweeper, support_sweeper, bounce_sweeper, cart_sweeper, alert_sweeper, rewards_sweeper,
                     flash_sweeper, referral_sweeper, health_sweeper, message_sweeper, campaign_sweeper,
                     backup_sweeper):
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


app = FastAPI(
    title=settings.APP_NAME,
    version="1.0.0",
    description=(
        "Backend for the Daily Choice Zone storefront and admin portal.\n\n"
        "Every response uses the same envelope: `{ success, data, message }`, "
        "with `pagination` on list endpoints and `error_code` on failures."
    ),
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

# Explicit origins, never "*": credentials cannot be sent to a wildcard origin,
# and an API that accepts every origin is one CSRF away from a bad day.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    # `ngrok-skip-browser-warning`: behind a free ngrok tunnel, a browser
    # request without it gets ngrok's HTML warning page instead of this API —
    # no CORS headers, so the browser reports a CORS error. The storefront
    # sends it only when its API URL is an ngrok host. It carries no authority.
    allow_headers=["Authorization", "Content-Type", "ngrok-skip-browser-warning"],
)

register_error_handlers(app)

# Every router carries the audit capture: any change an administrator makes,
# and any request an administrator is refused, is recorded — see
# `services.audit`. It writes nothing for customers' own requests.
from fastapi import Depends  # noqa: E402

from app.services import audit  # noqa: E402

for router in all_routers:
    app.include_router(router, prefix=settings.API_PREFIX, dependencies=[Depends(audit.capture)])

# Google's OAuth redirect lands outside /api, at the address the OAuth client
# is registered with (GOOGLE_REDIRECT_URI = <api>/auth/callback).
from app.api.routes.email import callback_router  # noqa: E402

app.include_router(callback_router)


@app.get("/health/live", tags=["Health"], summary="Liveness: is the process up?")
def health_live():
    """No database, no dependencies: only whether the process answers. Nothing internal is shown."""
    from app.services import health as health_service

    return {"success": True, "data": health_service.liveness()}


@app.get("/health/ready", tags=["Health"], summary="Readiness: can it take traffic?")
def health_ready():
    """
    The database answers and the schema is current. 503 otherwise, so a load
    balancer stops sending traffic. Statuses only — no hosts, versions or errors.
    """
    from fastapi.responses import JSONResponse

    from app.core.database import SessionLocal
    from app.services import health as health_service

    db = SessionLocal()
    try:
        ready, payload = health_service.readiness(db)
    finally:
        if not db.info.get("test_session"):
            db.close()
    return JSONResponse({"success": ready, "data": payload}, status_code=200 if ready else 503)


@app.get("/health", tags=["Health"], summary="Liveness and database check")
def health():
    """
    Is the process up, and can it reach the database?

    Checks the database rather than only returning 200, because a process that
    is running but cannot reach MySQL is not healthy — and a load balancer that
    keeps sending it traffic is making things worse.
    """
    from sqlalchemy import text

    from app.core.database import engine

    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        database = "ok"
    except Exception:  # noqa: BLE001 — the reason is logged, not returned
        logger.exception("Health check could not reach the database")
        database = "unreachable"

    return {
        "success": database == "ok",
        "data": {
            "status": "ok" if database == "ok" else "degraded",
            "database": database,
            "environment": settings.ENVIRONMENT,
        },
    }
