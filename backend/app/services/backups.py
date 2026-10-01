"""
Automated MySQL backups.

## How a backup is made

1. A MySQL named lock (`GET_LOCK`) makes sure only one backup runs, whichever
   server process the job is in.
2. The dump reads every table inside one `START TRANSACTION WITH CONSISTENT
   SNAPSHOT` — a single point in time, without locking the shop — and writes
   `CREATE TABLE` and `INSERT` statements, values escaped by the database
   driver. It's done in Python over the application's own connection, so no
   `mysqldump` binary is needed and the database password never appears on a
   command line or in the file.
3. The SQL is gzipped and, when `BACKUP_ENCRYPTION_KEY` is set, encrypted in
   chunks with AES-256-GCM (a fresh nonce per chunk), into a temporary file.
4. Its SHA-256 is taken and it's moved into storage: a private folder on this
   server (outside anything the web servers serve), or S3 under
   `database-backups/` with server-side encryption, separate from product
   photos.
5. **It's verified**, not assumed: the stored file is read back, its checksum
   compared, and it's decrypted and decompressed end to end to check the
   closing line lists every table that was dumped. Only then is it marked
   succeeded.

## When, and for how long

The schedule (every 6 or 12 hours, daily, weekly) and retention live in the
`backups` settings document, edited in the portal. Retention keeps daily
backups for N days and weekly ones (the first of each week) for N weeks, and
never deletes the newest backup that verified.

## Restoring

Deliberately not a button. `python -m app.tools.backup decrypt <file> <out.sql>`
turns a downloaded backup back into SQL, which is restored into a **new**
database and checked before anything is switched over — see the backups
section of docs/messaging-and-backups.md.
"""

from __future__ import annotations

import copy
import gzip
import hashlib
import hmac
import io
import logging
import os
import secrets
import shutil
import struct
import tempfile
import time
from datetime import datetime, timedelta
from typing import BinaryIO, Iterator, List, Optional

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ConflictError, NotFoundError, ValidationError
from app.models import AdminUser, DatabaseBackup, SettingDocument

logger = logging.getLogger(__name__)

MAGIC = b"DCZBK1\n"
CHUNK = 1024 * 1024
FOOTER = "-- Dump completed:"
FREQUENCIES = {"6h": 6, "12h": 12, "daily": 24, "weekly": 168}
INTERVAL_SECONDS = 300
LOCK_NAME = "dcz_database_backup"
MIN_SIZE = 64
DOWNLOAD_SECONDS = 300
IST = timedelta(hours=5, minutes=30)
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DEFAULTS = {
    "enabled": True,
    "frequency": "daily",
    "hour": 2,            # India time
    "weekday": 6,         # 0 = Monday … 6 = Sunday, for weekly backups and the weekly tier
    "keepDailyDays": 7,
    "keepWeeklyWeeks": 4,
    "keepManual": 5,
}


class BackupError(Exception):
    pass


# --------------------------------------------------------------- settings


def settings_doc(db: Session) -> dict:
    stored = (db.get(SettingDocument, "backups") or SettingDocument(value={})).value or {}
    merged = copy.deepcopy(DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k in DEFAULTS})
    return merged


def _whole(value, label: str, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{label} must be a whole number.", error_code="INVALID_SETTING") from None
    if not low <= number <= high:
        raise ValidationError(f"{label} must be between {low} and {high}.", error_code="INVALID_SETTING")
    return number


def save_settings(db: Session, admin: AdminUser, payload: dict) -> dict:
    from app.services import audit

    current = settings_doc(db)
    frequency = payload.get("frequency", current["frequency"])
    if frequency not in FREQUENCIES:
        raise ValidationError("Choose every 6 hours, every 12 hours, daily or weekly.", error_code="INVALID_SETTING")
    value = {
        "enabled": bool(payload.get("enabled", current["enabled"])),
        "frequency": frequency,
        "hour": _whole(payload.get("hour", current["hour"]), "The hour", 0, 23),
        "weekday": _whole(payload.get("weekday", current["weekday"]), "The weekday", 0, 6),
        "keepDailyDays": _whole(payload.get("keepDailyDays", current["keepDailyDays"]), "Daily backups kept (days)", 1, 365),
        "keepWeeklyWeeks": _whole(payload.get("keepWeeklyWeeks", current["keepWeeklyWeeks"]), "Weekly backups kept (weeks)", 0, 104),
        "keepManual": _whole(payload.get("keepManual", current["keepManual"]), "Manual backups kept", 1, 100),
    }
    row = db.get(SettingDocument, "backups")
    if row is None:
        db.add(SettingDocument(key="backups", value=value))
    else:
        row.value = value
    audit.record(db, "backups.settings", resource_type="backups", resource_id="settings", actor=admin,
                 summary="Changed the backup schedule and retention", changes=audit.diff(current, value))
    db.commit()
    return value


# ---------------------------------------------------------------- storage


class LocalStorage:
    name = "local"

    def __init__(self, directory: str):
        self.directory = os.path.abspath(directory)

    def describe(self) -> dict:
        try:
            usage = shutil.disk_usage(self.directory if os.path.isdir(self.directory) else BACKEND_DIR)
            free = usage.free
        except OSError:
            free = None
        return {"storage": self.name, "location": "A private folder on the API server", "freeBytes": free}

    def _path(self, key: str) -> str:
        path = os.path.abspath(os.path.join(self.directory, key))
        if not path.startswith(self.directory + os.sep):
            raise BackupError("Refusing a path outside the backup folder.")
        return path

    def put(self, source: str, key: str) -> None:
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        target = self._path(key)
        shutil.move(source, target)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass

    def open(self, key: str) -> BinaryIO:
        return open(self._path(key), "rb")

    def size(self, key: str) -> int:
        return os.path.getsize(self._path(key))

    def exists(self, key: str) -> bool:
        return os.path.isfile(self._path(key))

    def delete(self, key: str) -> None:
        try:
            os.remove(self._path(key))
        except FileNotFoundError:
            pass

    def download_url(self, key: str) -> Optional[str]:
        return None  # served by the API with a short-lived signed link


class S3Storage:
    name = "s3"

    def __init__(self, bucket: str, prefix: str):
        self.bucket, self.prefix = bucket, (prefix or "database-backups").strip("/")

    def describe(self) -> dict:
        return {"storage": self.name, "location": f"S3: {self.prefix}/ (private)", "freeBytes": None}

    def _client(self):
        from app.services import storage

        return storage._client(settings.AWS_ACCESS_KEY_ID, settings.AWS_SECRET_ACCESS_KEY, settings.AWS_REGION,
                               settings.AWS_S3_ENDPOINT_URL or None)

    def _key(self, key: str) -> str:
        return f"{self.prefix}/{key}"

    def put(self, source: str, key: str) -> None:
        with open(source, "rb") as handle:
            self._client().put_object(Bucket=self.bucket, Key=self._key(key), Body=handle, ACL="private",
                                      ServerSideEncryption="AES256", ContentType="application/octet-stream")
        os.remove(source)

    def open(self, key: str) -> BinaryIO:
        body = self._client().get_object(Bucket=self.bucket, Key=self._key(key))["Body"]
        spool = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024)
        for chunk in iter(lambda: body.read(CHUNK), b""):
            spool.write(chunk)
        spool.seek(0)
        return spool  # type: ignore[return-value]

    def size(self, key: str) -> int:
        return int(self._client().head_object(Bucket=self.bucket, Key=self._key(key))["ContentLength"])

    def exists(self, key: str) -> bool:
        try:
            self.size(key)
            return True
        except Exception:  # noqa: BLE001
            return False

    def delete(self, key: str) -> None:
        self._client().delete_object(Bucket=self.bucket, Key=self._key(key))

    def download_url(self, key: str) -> Optional[str]:
        return self._client().generate_presigned_url("get_object", Params={"Bucket": self.bucket,
                                                                          "Key": self._key(key)},
                                                     ExpiresIn=DOWNLOAD_SECONDS)


def local_dir() -> str:
    return settings.BACKUP_LOCAL_DIR or os.path.join(BACKEND_DIR, "var", "backups")


def storage(name: Optional[str] = None):
    name = (name or settings.BACKUP_STORAGE or "local").lower()
    if name == "s3":
        bucket = settings.BACKUP_S3_BUCKET or settings.AWS_S3_BUCKET
        if not (bucket and settings.AWS_ACCESS_KEY_ID and settings.AWS_SECRET_ACCESS_KEY):
            raise BackupError("S3 backups need BACKUP_S3_BUCKET (or AWS_S3_BUCKET) and the AWS keys.")
        return S3Storage(bucket, settings.BACKUP_S3_PREFIX)
    if name != "local":
        raise BackupError(f"Unknown backup storage '{name}'.")
    return LocalStorage(local_dir())


# ------------------------------------------------------------- encryption


def _key() -> Optional[bytes]:
    secret = settings.BACKUP_ENCRYPTION_KEY
    return hashlib.sha256(b"dcz-backup:" + secret.encode()).digest() if secret else None


class _EncryptingWriter(io.RawIOBase):
    """Collects bytes and writes them as [length][nonce][AES-GCM ciphertext] chunks."""

    def __init__(self, target: BinaryIO, key: bytes):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        self.target, self.aead, self.buffer = target, AESGCM(key), bytearray()
        target.write(MAGIC)

    def writable(self) -> bool:
        return True

    def write(self, data) -> int:
        self.buffer.extend(data)
        while len(self.buffer) >= CHUNK:
            self._flush_chunk(bytes(self.buffer[:CHUNK]))
            del self.buffer[:CHUNK]
        return len(data)

    def _flush_chunk(self, chunk: bytes) -> None:
        nonce = os.urandom(12)
        sealed = self.aead.encrypt(nonce, chunk, MAGIC)
        self.target.write(struct.pack(">I", len(sealed)) + nonce + sealed)

    def close(self) -> None:
        if not self.closed:
            if self.buffer:
                self._flush_chunk(bytes(self.buffer))
                self.buffer.clear()
            self.target.flush()
        super().close()


def decrypt_stream(source: BinaryIO, key: Optional[bytes] = None) -> Iterator[bytes]:
    """The gzip bytes of a backup file, decrypting it if it was encrypted."""
    head = source.read(len(MAGIC))
    if head != MAGIC:
        yield head
        yield from iter(lambda: source.read(CHUNK), b"")
        return
    key = key or _key()
    if key is None:
        raise BackupError("This backup is encrypted: set BACKUP_ENCRYPTION_KEY to the key it was made with.")
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aead = AESGCM(key)
    while True:
        size_bytes = source.read(4)
        if not size_bytes:
            return
        (size,) = struct.unpack(">I", size_bytes)
        nonce = source.read(12)
        sealed = source.read(size)
        try:
            yield aead.decrypt(nonce, sealed, MAGIC)
        except InvalidTag:
            raise BackupError("The backup couldn't be decrypted — wrong key, or the file is damaged.") from None


class _IterReader(io.RawIOBase):
    def __init__(self, chunks: Iterator[bytes]):
        self.chunks, self.leftover = chunks, b""

    def readable(self) -> bool:
        return True

    def readinto(self, buffer) -> int:
        while not self.leftover:
            try:
                self.leftover = next(self.chunks)
            except StopIteration:
                return 0
        n = min(len(buffer), len(self.leftover))
        buffer[:n] = self.leftover[:n]
        self.leftover = self.leftover[n:]
        return n


def sql_lines(source: BinaryIO, key: Optional[bytes] = None) -> Iterator[str]:
    """The SQL in a backup file, line by line."""
    reader = io.BufferedReader(_IterReader(decrypt_stream(source, key)), buffer_size=CHUNK)
    with gzip.GzipFile(fileobj=reader) as unzipped:
        for line in io.TextIOWrapper(unzipped, encoding="utf-8"):
            yield line


# ------------------------------------------------------------------- dump


def _dump(connection, out) -> tuple:
    """Write the database as SQL. Returns (tables, rows)."""
    raw = connection.connection.dbapi_connection
    escape = raw.escape
    database = connection.execute(text("SELECT DATABASE()")).scalar()
    tables = [row[0] for row in connection.execute(text("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'"))]
    out.write(f"-- Daily Choice Zone database backup\n-- Database: {database}\n"
              f"-- Created: {datetime.utcnow().isoformat()}Z (UTC)\n-- Tables: {len(tables)}\n"
              "-- Restore into a NEW database, never over the live one. See docs/messaging-and-backups.md.\n\n"
              "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\n\n")
    total = 0
    for table in tables:
        quoted = f"`{table.replace('`', '``')}`"
        create = connection.execute(text(f"SHOW CREATE TABLE {quoted}")).fetchone()[1]
        out.write(f"-- Table: {table}\nDROP TABLE IF EXISTS {quoted};\n{create};\n")
        result = connection.execution_options(stream_results=True).execute(text(f"SELECT * FROM {quoted}"))
        columns = ", ".join(f"`{c}`" for c in result.keys())
        batch: List[str] = []
        count = 0
        for row in result:
            batch.append("(" + ", ".join(escape(value) if not isinstance(value, (bytes, bytearray))
                                         else "X'" + bytes(value).hex() + "'" for value in row) + ")")
            count += 1
            if len(batch) >= 200:
                out.write(f"INSERT INTO {quoted} ({columns}) VALUES\n" + ",\n".join(batch) + ";\n")
                batch = []
        if batch:
            out.write(f"INSERT INTO {quoted} ({columns}) VALUES\n" + ",\n".join(batch) + ";\n")
        out.write(f"-- Rows: {count}\n\n")
        total += count
    out.write(f"SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n{FOOTER} {len(tables)} tables, {total} rows\n")
    return len(tables), total


def _verify(store, location: str, *, checksum: str, tables: int) -> None:
    size = store.size(location)
    if size < MIN_SIZE:
        raise BackupError(f"The stored backup is too small ({size} bytes) to be a real one.")
    digest = hashlib.sha256()
    with store.open(location) as handle:
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            digest.update(chunk)
    if digest.hexdigest() != checksum:
        raise BackupError("The stored backup doesn't match its checksum.")
    seen, footer = 0, ""
    with store.open(location) as handle:
        for line in sql_lines(handle):
            if line.startswith("-- Table: "):
                seen += 1
            elif line.startswith(FOOTER):
                footer = line
    if not footer:
        raise BackupError("The backup is incomplete: its closing line is missing.")
    if seen != tables or f" {tables} tables" not in footer:
        raise BackupError(f"The backup has {seen} tables but {tables} were dumped.")


def _reference(now: datetime) -> str:
    return f"BKP-{now:%Y%m%d-%H%M%S}-{secrets.token_hex(2).upper()}"


def run_backup(db: Session, *, trigger: str = "scheduled", admin: Optional[AdminUser] = None,
               tier: Optional[str] = None) -> DatabaseBackup:
    """Make, store and verify one backup. Records failure rather than raising, except for "already running"."""
    from sqlalchemy.engine import Engine

    # A named lock belongs to one connection, so it's taken and released on a
    # connection of its own, held for the whole backup — a session can switch
    # connections between commits, and a lock released on another one never is.
    bind = db.get_bind()
    own_lock = isinstance(bind, Engine)
    lock = bind.connect() if own_lock else bind
    try:
        # Lock names are server-wide in MySQL: named after the database being backed up,
        # so backups of different databases on one server never block each other.
        name = f"{LOCK_NAME}:{lock.execute(text('SELECT DATABASE()')).scalar()}"[:64]
        if not lock.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": name}).scalar():
            raise ConflictError("A backup is already running.", error_code="BACKUP_RUNNING")
        try:
            return _run_locked(db, trigger=trigger, admin=admin, tier=tier)
        finally:
            lock.execute(text("SELECT RELEASE_LOCK(:n)"), {"n": name})
    finally:
        if own_lock:
            lock.close()


def _run_locked(db: Session, *, trigger: str, admin: Optional[AdminUser], tier: Optional[str]) -> DatabaseBackup:
    now = datetime.utcnow()
    conf = settings_doc(db)
    if tier is None:
        tier = "manual" if trigger == "manual" else _tier(db, conf, now)
    row = DatabaseBackup(reference=_reference(now), trigger=trigger, tier=tier, status="running",
                         database_name=settings.DATABASE_NAME, storage=(settings.BACKUP_STORAGE or "local").lower(),
                         encrypted=_key() is not None, started_at=now, created_by=admin.id if admin else None)
    db.add(row)
    db.commit()
    temp_path = ""
    clock = time.monotonic()
    try:
        store = storage()
        handle, temp_path = tempfile.mkstemp(prefix="dcz-backup-", suffix=".tmp")
        os.close(handle)
        with open(temp_path, "wb") as raw_file:
            key = _key()
            sink = io.BufferedWriter(_EncryptingWriter(raw_file, key), buffer_size=CHUNK) if key else raw_file
            with gzip.GzipFile(fileobj=sink, mode="wb", compresslevel=6) as zipped, \
                    io.TextIOWrapper(zipped, encoding="utf-8") as out:
                from sqlalchemy.engine import Engine

                bind = db.get_bind()
                # Its own connection, so the dump reads one consistent snapshot. (Given a
                # connection already — the test suite's — it reads through that one.)
                own = isinstance(bind, Engine)
                connection = bind.connect() if own else bind
                try:
                    if own:
                        connection.execute(text("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
                        connection.execute(text("START TRANSACTION WITH CONSISTENT SNAPSHOT"))
                    tables, rows = _dump(connection, out)
                finally:
                    if own:
                        connection.rollback()
                        connection.close()
            if key:
                sink.close()
        digest = hashlib.sha256()
        with open(temp_path, "rb") as source:
            for chunk in iter(lambda: source.read(CHUNK), b""):
                digest.update(chunk)
        checksum = digest.hexdigest()
        location = f"{row.reference}.sql.gz{'.enc' if row.encrypted else ''}"
        store.put(temp_path, location)
        temp_path = ""
        _verify(store, location, checksum=checksum, tables=tables)
        row.location, row.checksum_sha256 = location, checksum
        row.size_bytes, row.tables, row.rows = store.size(location), tables, rows
        row.status, row.completed_at, row.verified_at = "succeeded", datetime.utcnow(), datetime.utcnow()
        logger.info("Backup %s succeeded: %s tables, %s rows, %s bytes, %.1fs", row.reference, tables, rows,
                    row.size_bytes, time.monotonic() - clock)
        db.commit()
        _apply_retention(db, conf)
    except Exception as error:  # noqa: BLE001 — recorded; the shop carries on
        db.rollback()
        row = db.get(DatabaseBackup, row.id)
        row.status, row.completed_at = "failed", datetime.utcnow()
        row.error = _describe(error)
        db.commit()
        logger.error("Backup %s failed: %s", row.reference, row.error)
        _alert_failure(db, row)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)
    db.refresh(row)
    return row


def _describe(error: Exception) -> str:
    """The failure, without anything that could be a credential."""
    message = f"{type(error).__name__}: {error}"
    for secret in (settings.DATABASE_PASSWORD, settings.AWS_SECRET_ACCESS_KEY, settings.BACKUP_ENCRYPTION_KEY):
        if secret:
            message = message.replace(secret, "••••")
    return message[:1000]


def _alert_failure(db: Session, row: DatabaseBackup) -> None:
    from app.services import inbox

    try:
        inbox.staff(db, "backup", "Database backup failed", f"{row.reference}: {row.error[:300]}",
                    "/admin/settings/backups", permission="backups")
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("Could not alert the team about failed backup %s", row.reference)


# --------------------------------------------------------------- schedule


def _tier(db: Session, conf: dict, now: datetime) -> str:
    """Weekly for a weekly schedule, and for the first backup of each week on the chosen day."""
    if conf["frequency"] == "weekly":
        return "weekly"
    local = now + IST
    if local.weekday() != conf["weekday"]:
        return "daily"
    week_start = (local - timedelta(days=local.weekday())).replace(hour=0, minute=0, second=0, microsecond=0) - IST
    already = db.execute(select(DatabaseBackup.id).where(DatabaseBackup.tier == "weekly",
                                                         DatabaseBackup.status == "succeeded",
                                                         DatabaseBackup.started_at >= week_start).limit(1)).first()
    return "daily" if already else "weekly"


def next_run(db: Session, now: Optional[datetime] = None) -> Optional[datetime]:
    conf = settings_doc(db)
    if not conf["enabled"]:
        return None
    now = now or datetime.utcnow()
    last = db.execute(select(func.max(DatabaseBackup.started_at)).where(
        DatabaseBackup.trigger == "scheduled", DatabaseBackup.status.in_(("running", "succeeded", "failed")))).scalar()
    hours = FREQUENCIES[conf["frequency"]]
    if hours < 24:
        return (last + timedelta(hours=hours)) if last else now
    # Daily and weekly run at a set hour, India time.
    local_now = now + IST
    candidate = local_now.replace(hour=conf["hour"], minute=0, second=0, microsecond=0)
    if conf["frequency"] == "weekly":
        candidate += timedelta(days=(conf["weekday"] - candidate.weekday()) % 7)
    step = timedelta(days=7 if conf["frequency"] == "weekly" else 1)
    due = candidate - IST
    if last is None:
        return due if due >= now else now if (now - due) < step else due + step
    while due <= last:
        due += step
    return due


def due(db: Session, now: Optional[datetime] = None) -> bool:
    when = next_run(db, now)
    return when is not None and when <= (now or datetime.utcnow())


# -------------------------------------------------------------- retention


def _apply_retention(db: Session, conf: Optional[dict] = None, now: Optional[datetime] = None) -> int:
    """Delete backups past their tier's keeping time. Never the newest verified one."""
    conf = conf or settings_doc(db)
    now = now or datetime.utcnow()
    good = db.execute(select(DatabaseBackup).where(DatabaseBackup.status == "succeeded")
                      .order_by(DatabaseBackup.started_at.desc())).scalars().all()
    if not good:
        return 0
    newest = good[0].id
    manual = [b for b in good if b.tier == "manual"]
    expired = []
    for backup in good:
        if backup.id == newest:
            continue
        age = now - backup.started_at
        if backup.tier == "daily" and age > timedelta(days=conf["keepDailyDays"]):
            expired.append(backup)
        elif backup.tier == "weekly" and age > timedelta(weeks=conf["keepWeeklyWeeks"]):
            expired.append(backup)
    expired += [b for b in manual[conf["keepManual"]:] if b.id != newest and b not in expired]
    removed = 0
    for backup in expired:
        try:
            storage(backup.storage).delete(backup.location)
        except Exception as error:  # noqa: BLE001 — try again next time
            logger.warning("Could not delete expired backup %s: %s", backup.reference, _describe(error))
            continue
        backup.status, backup.deleted_at = "deleted", now
        removed += 1
    if removed:
        db.commit()
        logger.info("Retention removed %s old backup%s", removed, "s" if removed != 1 else "")
    return removed


# ------------------------------------------------------------------ admin


def view(row: DatabaseBackup) -> dict:
    return {
        "id": row.id, "reference": row.reference, "trigger": row.trigger, "tier": row.tier, "status": row.status,
        "databaseName": row.database_name, "storage": row.storage, "location": row.location,
        "sizeBytes": row.size_bytes, "checksum": row.checksum_sha256, "encrypted": row.encrypted,
        "tables": row.tables, "rows": row.rows, "verifiedAt": row.verified_at, "error": row.error,
        "startedAt": row.started_at, "completedAt": row.completed_at, "deletedAt": row.deleted_at,
        "durationSeconds": int((row.completed_at - row.started_at).total_seconds()) if row.completed_at else None,
    }


def overview(db: Session) -> dict:
    last_good = db.execute(select(DatabaseBackup).where(DatabaseBackup.status == "succeeded")
                           .order_by(DatabaseBackup.started_at.desc()).limit(1)).scalar_one_or_none()
    last_failed = db.execute(select(DatabaseBackup).where(DatabaseBackup.status == "failed")
                             .order_by(DatabaseBackup.started_at.desc()).limit(1)).scalar_one_or_none()
    running = db.execute(select(DatabaseBackup).where(DatabaseBackup.status == "running")
                         .order_by(DatabaseBackup.started_at.desc()).limit(1)).scalar_one_or_none()
    kept = db.execute(select(func.count(), func.coalesce(func.sum(DatabaseBackup.size_bytes), 0)).where(
        DatabaseBackup.status == "succeeded")).one()
    try:
        where = storage().describe()
        storage_problem = ""
    except BackupError as error:
        where, storage_problem = {"storage": settings.BACKUP_STORAGE, "location": "", "freeBytes": None}, str(error)
    return {
        "settings": settings_doc(db),
        "lastSuccess": view(last_good) if last_good else None,
        "lastFailure": view(last_failed) if last_failed else None,
        "running": view(running) if running else None,
        "nextRun": next_run(db),
        "kept": int(kept[0]), "keptBytes": int(kept[1]),
        "storage": where, "storageProblem": storage_problem,
        "encrypted": _key() is not None,
        "warnings": ([] if _key() else ["BACKUP_ENCRYPTION_KEY isn't set, so backups are stored unencrypted. "
                                        "Set it (and keep it safe elsewhere) to encrypt them."])
                    + ([storage_problem] if storage_problem else []),
    }


def history(db: Session, *, status: str = "", page: int = 1, page_size: int = 25) -> tuple:
    conditions = [DatabaseBackup.status == status] if status else []
    total = db.execute(select(func.count()).select_from(DatabaseBackup).where(*conditions)).scalar_one()
    rows = db.execute(select(DatabaseBackup).where(*conditions).order_by(DatabaseBackup.started_at.desc())
                      .offset((page - 1) * page_size).limit(page_size)).scalars().all()
    counts = dict(db.execute(select(DatabaseBackup.status, func.count()).group_by(DatabaseBackup.status)).all())
    return [view(r) for r in rows], int(total), {k: int(v) for k, v in counts.items()}


def _download_signature(backup_id: int, admin_id: str, expires: int) -> str:
    return hmac.new(f"backup-download:{settings.JWT_SECRET_KEY}".encode(), f"{backup_id}:{admin_id}:{expires}".encode(),
                    hashlib.sha256).hexdigest()


def download_link(db: Session, admin: AdminUser, backup_id: int) -> dict:
    """A link that works for five minutes, for this administrator and this backup only."""
    from app.services import audit

    row = db.get(DatabaseBackup, backup_id)
    if row is None or row.status != "succeeded":
        raise NotFoundError("That backup isn't available to download.", error_code="BACKUP_NOT_FOUND")
    expires = int(time.time()) + DOWNLOAD_SECONDS
    audit.record(db, "backups.download", resource_type="backups", resource_id=row.reference, actor=admin,
                 summary=f"Downloaded backup {row.reference}")
    db.commit()
    store = storage(row.storage)
    direct = store.download_url(row.location)
    if direct:
        return {"url": direct, "expiresIn": DOWNLOAD_SECONDS, "fileName": row.location}
    token = f"{admin.id}.{expires}.{_download_signature(row.id, admin.id, expires)}"
    return {"url": f"{settings.API_PREFIX}/admin/backups/{row.id}/file?token={token}", "expiresIn": DOWNLOAD_SECONDS,
            "fileName": row.location}


def open_for_download(db: Session, backup_id: int, token: str) -> tuple:
    """(file handle, file name) for a valid link; refuses anything expired or forged."""
    from app.models import AdminUser as Admin

    try:
        admin_id, expires_text, signature = token.split(".")
        expires = int(expires_text)
    except (ValueError, AttributeError):
        raise NotFoundError("This download link isn't valid.", error_code="BACKUP_LINK_INVALID") from None
    if expires < time.time() or not hmac.compare_digest(_download_signature(backup_id, admin_id, expires), signature):
        raise NotFoundError("This download link has expired.", error_code="BACKUP_LINK_INVALID")
    admin = db.get(Admin, admin_id)
    from app.core.permissions import permissions_for

    if admin is None or admin.status != "active" or not (
            admin.role == "super-admin" or "backups" in (admin.permissions or []) or "backups" in permissions_for(admin.role)):
        raise NotFoundError("This download link isn't valid.", error_code="BACKUP_LINK_INVALID")
    row = db.get(DatabaseBackup, backup_id)
    if row is None or row.status != "succeeded":
        raise NotFoundError("That backup isn't available.", error_code="BACKUP_NOT_FOUND")
    return storage(row.storage).open(row.location), row.location


def start_manual(db: Session, admin: AdminUser) -> DatabaseBackup:
    from app.services import audit

    audit.record(db, "backups.run", resource_type="backups", resource_id="manual", actor=admin,
                 summary="Started a backup by hand")
    db.commit()
    return run_backup(db, trigger="manual", admin=admin)


# --------------------------------------------------------------- the loop


def sweep(db: Session) -> Optional[DatabaseBackup]:
    # A backup left "running" by a process that died is failed, so it doesn't block the schedule.
    stale = datetime.utcnow() - timedelta(hours=3)
    for row in db.execute(select(DatabaseBackup).where(DatabaseBackup.status == "running",
                                                       DatabaseBackup.started_at < stale)).scalars():
        row.status, row.completed_at, row.error = "failed", datetime.utcnow(), "Interrupted: the server stopped mid-backup."
    db.commit()
    if not due(db):
        return None
    try:
        return run_backup(db)
    except ConflictError:
        return None


def _sweep_once() -> None:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        try:
            sweep(db)
        except Exception:
            db.rollback()
            raise


async def run_forever() -> None:
    import asyncio

    from app.services import jobs

    logger.info("Backups checked every %ss.", INTERVAL_SECONDS)
    while True:
        try:
            await asyncio.to_thread(jobs.tracked("backups", INTERVAL_SECONDS, _sweep_once))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("Backup check failed; retrying next interval.")
        await asyncio.sleep(INTERVAL_SECONDS)
