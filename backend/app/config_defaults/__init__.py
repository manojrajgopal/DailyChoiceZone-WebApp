"""
The configuration a brand-new installation starts with.

## Why this exists at all

A store cannot run on an empty `setting_documents` table. Without a currency
there is no way to print a price, without a tax document no way to decide
whether a sale is intra-state, and without a menu the header has nothing to
draw. Something has to put a first version of each document in the database.

## Why it is not dummy data

This is **initial state, written once**, not a dataset the application reads at
runtime. Nothing in `app/` imports it except the migration that installs it.
After that first migration the database is the only source, every value is
editable from the admin portal, and this module is never read again.

That is the difference from the demo JSON that used to live in `app/seed/`:
those files were a fabricated catalogue — 140 products, 66 customers, 176
orders — reloaded on every boot. There is no equivalent here. A fresh
installation has a configured store and an empty catalogue, which is what a
real shop starts as.

## Adding to it

Don't, unless a *new* document is being introduced. Changing a value here has
no effect on any installation that has already migrated — it would only change
what the next fresh one starts with. To change a running store, use the portal.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

_PATH = Path(__file__).resolve().parent / "documents.json"


def initial_documents() -> Dict[str, dict]:
    """The document set a fresh database is given, keyed as `setting_documents.key`."""
    return json.loads(_PATH.read_text(encoding="utf-8"))
