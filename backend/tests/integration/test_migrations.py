"""
The migrations build the same database the models describe.

The rest of the suite builds its schema with `create_all()` from the models.
Production is built by `alembic upgrade head`. If the two ever drift (a
migration that forgets a unique index, or a different ON DELETE rule) every
test passes while the real database behaves differently. So here a database of
its own is built from the migrations, from empty, and compared with the models.

The database is `<test database>_migrations`, created and dropped by this
module. The development database is never named.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

import app.models  # noqa: F401
from app.core.config import settings
from app.core.database import Base
from tests.conftest import TEST_DATABASE

pytestmark = pytest.mark.integration

BACKEND = Path(__file__).resolve().parents[2]
NAME = f"{TEST_DATABASE}_migrations"


def _config(url: str) -> Config:
    # No ini file: env.py would otherwise run `fileConfig`, which switches off
    # every logger already created and breaks later tests that read logs.
    config = Config()
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    config.set_main_option("sqlalchemy.url", url)
    return config


@pytest.fixture(scope="module")
def migrated():
    assert NAME != settings.DATABASE_NAME
    server = create_engine(settings.server_url, isolation_level="AUTOCOMMIT")
    with server.connect() as connection:
        connection.execute(text(f"DROP DATABASE IF EXISTS `{NAME}`"))
        connection.execute(text(f"CREATE DATABASE `{NAME}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"))
    url = f"{settings.server_url}/{NAME}?charset=utf8mb4"
    command.upgrade(_config(url), "head")
    engine = create_engine(url)
    yield engine
    engine.dispose()
    with server.connect() as connection:
        connection.execute(text(f"DROP DATABASE IF EXISTS `{NAME}`"))
    server.dispose()


def _significant(diff):
    """Differences that change behaviour, leaving out MySQL's own spellings of the same thing."""
    out = []
    for entry in diff:
        entries = entry if isinstance(entry, list) else [entry]
        for item in entries:
            kind = item[0]
            if kind == "modify_default":
                continue  # MySQL reports server defaults in its own text form
            out.append(item)
    return out


class TestMigrations:
    def test_one_head(self):
        """Two heads means two people's migrations that nobody merged."""
        heads = ScriptDirectory.from_config(_config("mysql+pymysql://x")).get_heads()
        assert len(heads) == 1, heads

    def test_the_chain_is_unbroken(self):
        script = ScriptDirectory.from_config(_config("mysql+pymysql://x"))
        revisions = list(script.walk_revisions())
        assert revisions[-1].down_revision is None  # one root
        assert len({r.revision for r in revisions}) == len(revisions)

    def test_upgrade_reaches_head(self, migrated):
        with migrated.connect() as connection:
            current = MigrationContext.configure(connection).get_current_revision()
        assert current == ScriptDirectory.from_config(_config("mysql+pymysql://x")).get_current_head()

    def test_every_model_table_exists(self, migrated):
        tables = set(inspect(migrated).get_table_names())
        missing = set(Base.metadata.tables) - tables
        assert not missing, sorted(missing)

    def test_the_migrated_schema_matches_the_models(self, migrated):
        with migrated.connect() as connection:
            context = MigrationContext.configure(connection, opts={"compare_type": True})
            diff = _significant(compare_metadata(context, Base.metadata))
        assert diff == [], "\n".join(map(str, diff))

    def test_foreign_keys_have_the_same_delete_rules(self, migrated):
        """compare_metadata does not compare ON DELETE; this does."""
        actual = {}
        with migrated.connect() as connection:
            rows = connection.execute(text(
                "SELECT k.TABLE_NAME, k.COLUMN_NAME, r.DELETE_RULE FROM information_schema.KEY_COLUMN_USAGE k "
                "JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME "
                "AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA WHERE k.TABLE_SCHEMA = :db"), {"db": NAME})
            for table, column, rule in rows:
                actual[(table, column)] = rule
        mismatched = []
        for table in Base.metadata.sorted_tables:
            for fk in table.foreign_keys:
                expected = (fk.ondelete or "RESTRICT").upper().replace("NO ACTION", "RESTRICT")
                found = actual.get((table.name, fk.parent.name), "MISSING").replace("NO ACTION", "RESTRICT")
                if found != expected:
                    mismatched.append(f"{table.name}.{fk.parent.name}: model {expected}, migrations {found}")
        assert not mismatched, "\n".join(mismatched)

    def test_the_first_install_has_its_configuration(self, migrated):
        """A fresh install can't run without these documents; a migration installs them."""
        with migrated.connect() as connection:
            keys = set(connection.execute(text("SELECT `key` FROM setting_documents")).scalars())
        assert {"store", "billing", "tax", "site", "content", "navigation", "admin_navigation"} <= keys

    def test_a_fresh_install_has_no_business_data(self, migrated):
        """No demo customers, products or orders: a real shop starts empty."""
        with migrated.connect() as connection:
            for table in ("customers", "products", "orders", "admin_users"):
                assert connection.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar() == 0, table

    def test_upgrading_twice_changes_nothing(self, migrated):
        """Startup runs `upgrade head` on every boot; the second run must be a no-op."""
        command.upgrade(_config(migrated.url.render_as_string(hide_password=False)), "head")
        with migrated.connect() as connection:
            context = MigrationContext.configure(connection, opts={"compare_type": True})
            assert _significant(compare_metadata(context, Base.metadata)) == []
