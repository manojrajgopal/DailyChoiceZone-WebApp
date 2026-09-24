"""Database engine, session handling, and first-run creation."""

from __future__ import annotations

import logging
from typing import Generator

from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """Declarative base for every model."""


# `pool_pre_ping` costs one cheap round trip per checkout and saves the class of
# error where MySQL has dropped an idle connection and the first query of the
# morning fails. `pool_recycle` stays under MySQL's default 8-hour wait_timeout.
engine = create_engine(
    settings.database_url,
    echo=settings.DATABASE_ECHO,
    pool_pre_ping=True,
    pool_recycle=3600,
    pool_size=10,
    max_overflow=20,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, future=True)


def get_db() -> Generator[Session, None, None]:
    """
    Request-scoped session.

    One session per request, closed whatever happens. Commits are the service
    layer's business: a dependency that committed for you would turn every
    half-finished request into a half-written database.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_server_connection() -> None:
    """
    Confirm MySQL is reachable before anything else is attempted.

    Raises with a message that says what to do, because "Can't connect to MySQL
    server" with a stack trace is not a useful thing to hand someone at startup.
    """
    probe = create_engine(settings.server_url, pool_pre_ping=True)
    try:
        with probe.connect() as connection:
            connection.execute(text("SELECT 1"))
    except OperationalError as error:
        raise RuntimeError(
            f"Cannot reach MySQL at {settings.DATABASE_HOST}:{settings.DATABASE_PORT} "
            f"as user '{settings.DATABASE_USER}'.\n"
            f"  - Is the MySQL service running?\n"
            f"  - Do DATABASE_USER and DATABASE_PASSWORD in .env match?\n"
            f"Original error: {error.orig}"
        ) from error
    finally:
        probe.dispose()


def create_database_if_missing() -> bool:
    """
    Create the application database when it does not exist.

    `CREATE DATABASE IF NOT EXISTS` only — never a DROP. A startup routine that
    can delete a database is a startup routine that eventually will.

    Returns True when it created one, so the caller can tell a first run from a
    restart.
    """
    probe = create_engine(settings.server_url, isolation_level="AUTOCOMMIT")
    try:
        with probe.connect() as connection:
            existing = connection.execute(
                text(
                    "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA "
                    "WHERE SCHEMA_NAME = :name"
                ),
                {"name": settings.DATABASE_NAME},
            ).scalar()

            if existing:
                logger.info("Database '%s' already exists.", settings.DATABASE_NAME)
                return False

            # utf8mb4 so rupee signs, em dashes and emoji all survive a round
            # trip; utf8mb3 silently mangles anything outside the BMP.
            connection.execute(
                text(
                    f"CREATE DATABASE `{settings.DATABASE_NAME}` "
                    "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                )
            )
            logger.info("Created database '%s'.", settings.DATABASE_NAME)
            return True
    finally:
        probe.dispose()
