"""
Rebuild the development database from the demo data.

    python -m app.seed.reset --yes

**Nothing calls this.** It is not wired into startup, it is not a dependency,
and it is not imported by the application — because a process that can drop
tables while running unattended will eventually do so at the wrong moment. The
startup sequence only ever creates, migrates and inserts-if-absent.

It also refuses to run unless `DEBUG` is on and the database name is the
development one, so pointing it at a production URL by accident does nothing.
Use it when the seed's shape has changed — new ids, a new column's backfill —
and re-seeding on top of what is there would leave the two generations mixed.
"""

from __future__ import annotations

import argparse
import logging
import sys

from sqlalchemy import text

from app.core.config import settings
from app.core.database import Base, engine
from app.core.startup import run_migrations
from app.seed.seed_database import seed_all

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(name)s: %(message)s")
logger = logging.getLogger("reset")


def guard() -> None:
    """Refuse anywhere this would be a mistake rather than a convenience."""
    problems = []

    if not settings.DEBUG:
        problems.append("DEBUG is off — this looks like a deployed environment.")
    if settings.DATABASE_NAME != "daily_choice_zone":
        problems.append(
            f"the database is '{settings.DATABASE_NAME}', not the development one."
        )

    if problems:
        for problem in problems:
            logger.error("Refusing to reset: %s", problem)
        sys.exit(1)


def reset() -> None:
    logger.warning("Dropping every table in '%s'.", settings.DATABASE_NAME)

    # Foreign keys are switched off for the drop only — the tables reference
    # each other in a cycle that has no safe drop order, and they are all going.
    with engine.begin() as connection:
        connection.execute(text("SET FOREIGN_KEY_CHECKS = 0"))
        Base.metadata.drop_all(bind=connection)
        connection.execute(text("DROP TABLE IF EXISTS alembic_version"))
        connection.execute(text("SET FOREIGN_KEY_CHECKS = 1"))

    run_migrations()
    counts = seed_all()

    total = sum(counts.values())
    logger.info("Seeded %d records.", total)
    for name, count in sorted(counts.items()):
        if count:
            logger.info("  %-18s %d", name, count)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="required — confirms that every table will be dropped",
    )
    args = parser.parse_args()

    guard()

    if not args.yes:
        logger.error("This drops every table. Pass --yes if that is what you want.")
        sys.exit(1)

    reset()


if __name__ == "__main__":
    main()
