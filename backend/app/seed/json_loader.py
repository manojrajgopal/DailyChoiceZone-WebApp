"""Reading the demo JSON, and the id translation that goes with it."""

from __future__ import annotations

import json
import re
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.utils.ids import build_id_for

DATA_DIR = Path(__file__).resolve().parent / "data"


@lru_cache(maxsize=None)
def load(name: str) -> Any:
    """Read one seed file. Cached — several passes read the same files."""
    path = DATA_DIR / name
    if not path.exists():
        raise FileNotFoundError(f"Seed file missing: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def parse_dt(value: Optional[str]) -> Optional[datetime]:
    """
    ISO-8601 to a naive UTC datetime.

    Naive because MySQL's DATETIME has no zone: storing an aware value would
    have the driver silently drop the offset, which is how a timestamp ends up
    five and a half hours out. Everything is UTC by convention.
    """
    if not value:
        return None

    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        # A plain date, as the storefront reviews use.
        try:
            parsed = datetime.fromisoformat(f"{text}T00:00:00")
        except ValueError:
            return None

    return parsed.replace(tzinfo=None) if parsed.tzinfo is None else parsed.astimezone().replace(tzinfo=None)


class IdMap:
    """
    Translates the demo ids into the `PRD001` scheme.

    Every relationship in the demo data is expressed by id — an order line
    points at `prod_043`, an invoice at `order_0005`. Renumbering without
    rewriting those references would leave a database full of dangling
    pointers, so the whole mapping is built first and every write goes through
    it.

    Unmapped ids are returned unchanged rather than dropped, so a reference to
    something the seed does not contain stays visible instead of silently
    becoming NULL.
    """

    def __init__(self) -> None:
        self._maps: Dict[str, Dict[str, str]] = {}

    def build(self, entity: str, prefix: str, old_ids: List[str]) -> None:
        """
        Assign new ids in the order given, so numbering follows the data.

        The width is `build_id`'s and not this method's choice: an entity
        numbered to four digits here and to three by `next_id` produces two
        series that interleave, and the first order placed after the seed
        collides with a seeded record. Padding past the width is fine — INV1000
        simply follows INV999 — as long as one function decides it.
        """
        self._maps[entity] = {
            old: build_id_for(prefix, index) for index, old in enumerate(old_ids, start=1)
        }

    def get(self, entity: str, old_id: Optional[str]) -> Optional[str]:
        if old_id is None:
            return None
        return self._maps.get(entity, {}).get(old_id, old_id)

    def require(self, entity: str, old_id: str) -> str:
        """For references that must resolve; raises rather than writing a dangling id."""
        mapped = self._maps.get(entity, {}).get(old_id)
        if mapped is None:
            raise KeyError(f"No {entity} id mapped for '{old_id}'")
        return mapped

    def known(self, entity: str, old_id: Optional[str]) -> bool:
        return old_id is not None and old_id in self._maps.get(entity, {})

    def count(self, entity: str) -> int:
        return len(self._maps.get(entity, {}))


_DIGITS = re.compile(r"(\d+)")


def numeric_sort_key(identifier: str) -> tuple:
    """
    Sort `prod_9` before `prod_10`.

    Plain string ordering puts `prod_10` first, which would scramble the
    numbering so `PRD002` was not the second product anyone added.
    """
    parts = _DIGITS.split(identifier)
    return tuple(int(part) if part.isdigit() else part for part in parts)
