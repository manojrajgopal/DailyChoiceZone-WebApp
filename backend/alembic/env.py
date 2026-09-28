"""Alembic environment.

The target metadata comes from the application, so a migration can never be
generated against a different schema than the one the app runs on.

The URL comes from the application too, **unless the caller supplied one**.
That matters for anything that migrates a database other than the one in
`.env`: a staging deploy, or a check that a fresh installation comes up
correctly. Overwriting it unconditionally meant every such call silently
migrated the development database instead.
"""

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.config import settings
from app.core.database import Base

# Importing the package registers every model on `Base.metadata`. Without it
# autogenerate would see an empty schema and cheerfully emit DROP TABLE for
# everything that exists.
import app.models  # noqa: F401

config = context.config

# `alembic.ini` deliberately carries no URL, so an empty value here means
# nobody asked for a particular database and the application's own is right.
if not config.get_main_option("sqlalchemy.url", default=None):
    config.set_main_option("sqlalchemy.url", settings.database_url)

database_url = config.get_main_option("sqlalchemy.url")

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of running it — for review, or a DBA."""
    context.configure(
        url=database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # Catch a column whose type changed, not just one that appeared.
            compare_type=True,
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
