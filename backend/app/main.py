"""Daily Choice Zone API."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import all_routers
from app.api.routes.admin.uploads import upload_root
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

    try:
        yield
    finally:
        if sweeper is not None:
            sweeper.cancel()
            try:
                await sweeper
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

for router in all_routers:
    app.include_router(router, prefix=settings.API_PREFIX)

# Uploaded product photographs, read-only. Every file here was re-encoded by
# `routes/admin/uploads.py`; nothing an uploader sent is served as sent.
app.mount("/uploads", StaticFiles(directory=upload_root()), name="uploads")


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
