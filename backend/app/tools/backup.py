"""
Backup files from the command line: check one, or turn it back into SQL.

    python -m app.tools.backup verify  <backup-file>
    python -m app.tools.backup decrypt <backup-file> <output.sql>

`decrypt` needs the BACKUP_ENCRYPTION_KEY the backup was made with (from the
environment or backend/.env) when the file ends in `.enc`. The SQL it writes
is meant to be loaded into a **new, empty** database —

    mysql -u <user> -p -e "CREATE DATABASE dcz_restore CHARACTER SET utf8mb4"
    mysql -u <user> -p dcz_restore < output.sql

— checked there, and only then switched to. Never load it over the live
database. See docs/messaging-and-backups.md.
"""

from __future__ import annotations

import hashlib
import sys

from app.services import backups


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(backups.CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path: str) -> int:
    tables, footer = 0, ""
    with open(path, "rb") as handle:
        for line in backups.sql_lines(handle):
            if line.startswith("-- Table: "):
                tables += 1
            elif line.startswith(backups.FOOTER):
                footer = line.strip()
    print(f"sha256  {_sha256(path)}")
    if not footer:
        print("INCOMPLETE: the closing line is missing.")
        return 1
    print(f"tables  {tables}\n{footer}\nOK")
    return 0


def decrypt(path: str, target: str) -> int:
    with open(path, "rb") as handle, open(target, "w", encoding="utf-8", newline="\n") as out:
        for line in backups.sql_lines(handle):
            out.write(line)
    print(f"Wrote {target}. Load it into a NEW database, never over the live one.")
    return 0


def main(argv: list) -> int:
    if len(argv) >= 2 and argv[0] == "verify":
        return verify(argv[1])
    if len(argv) >= 3 and argv[0] == "decrypt":
        return decrypt(argv[1], argv[2])
    print(__doc__)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except backups.BackupError as error:
        print(f"ERROR: {error}")
        sys.exit(1)
