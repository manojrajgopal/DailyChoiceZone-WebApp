"""The startup sequence: reachable, exists, migrated, seeded."""

from __future__ import annotations

import logging
from pathlib import Path

from alembic import command
from alembic.config import Config

from app.core.config import settings
from app.core.database import check_server_connection, create_database_if_missing

logger = logging.getLogger(__name__)

BACKEND_ROOT = Path(__file__).resolve().parents[2]


def _alembic_config() -> Config:
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    config.set_main_option("sqlalchemy.url", settings.database_url)
    return config


def run_migrations() -> None:
    """
    Bring the schema up to head.

    **Upgrade only.** Never `downgrade`, never `drop_all`. A process that runs
    unattended at startup must not be able to destroy data, however convenient
    that would occasionally be during development.
    """
    logger.info("Applying migrations…")
    command.upgrade(_alembic_config(), "head")
    logger.info("Schema is at head.")


def prepare_database() -> None:
    """
    Everything that has to be true before the first request.

        1. MySQL is reachable          — fail with instructions if not
        2. the database exists         — create it if it does not
        3. the schema is current       — alembic upgrade head
        4. the demo data is loaded     — seed, idempotently

    Each step can be switched off independently (`AUTO_CREATE_DATABASE`,
    `AUTO_MIGRATE`, `AUTO_SEED`), because a production deployment usually
    migrates from its own pipeline and must never seed.
    """
    check_server_connection()

    if settings.AUTO_CREATE_DATABASE:
        create_database_if_missing()
    else:
        logger.info("AUTO_CREATE_DATABASE is off; assuming the database exists.")

    if settings.AUTO_MIGRATE:
        run_migrations()
    else:
        logger.info("AUTO_MIGRATE is off; assuming the schema is current.")

    if settings.AUTO_SEED:
        # Imported here, not at module load: the seeder imports models, which
        # import the engine, and pulling that in before the database exists
        # turns a clear error into an import-time one.
        from app.seed.seed_database import seed_all

        seed_all()
    else:
        logger.info("AUTO_SEED is off; not touching the data.")
