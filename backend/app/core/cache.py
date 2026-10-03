"""
A small in-process cache for answers that are expensive to work out and cheap
to be a little late about: recommendation lists, a pincode's delivery terms.

## Namespaces and versions

Every entry lives in a namespace (`recommendations`, `delivery`). Invalidating
a namespace bumps its version rather than walking the keys, so "a product
changed, forget every recommendation" is O(1) and can't miss an entry. Old
entries simply stop matching and age out.

## What it is not

It is per process. With several workers, an edit clears the cache in the
worker that handled it and the others catch up within the TTL — which is why
the TTLs are short and why nothing whose staleness costs money (stock, price,
the final checkout decision) is ever read from here. Checkout always works
from the locked rows.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Hashable, Tuple

_lock = threading.Lock()
_entries: Dict[Tuple[str, int, Hashable], Tuple[float, Any]] = {}
_versions: Dict[str, int] = {}
# A ceiling, so a crawler walking every pincode can't grow this without bound.
MAX_ENTRIES = 5000


def _version(namespace: str) -> int:
    return _versions.get(namespace, 0)


def get_or_set(namespace: str, key: Hashable, ttl_seconds: int, compute: Callable[[], Any]) -> Any:
    """The cached value for `key`, or `compute()` stored for `ttl_seconds`. A TTL of 0 disables caching."""
    if ttl_seconds <= 0:
        return compute()
    now = time.monotonic()
    with _lock:
        full_key = (namespace, _version(namespace), key)
        hit = _entries.get(full_key)
        if hit is not None and hit[0] > now:
            return hit[1]
    value = compute()
    with _lock:
        # Re-read the version: an invalidation while computing means this
        # value may already be stale, so it is returned but not kept.
        if _version(namespace) == full_key[1]:
            if len(_entries) >= MAX_ENTRIES:
                _evict(now)
            _entries[full_key] = (now + ttl_seconds, value)
    return value


def _evict(now: float) -> None:
    expired = [k for k, (until, _) in _entries.items() if until <= now or k[1] != _version(k[0])]
    for k in expired:
        _entries.pop(k, None)
    if len(_entries) >= MAX_ENTRIES:
        # Still full of live entries: drop the oldest half.
        for k, _ in sorted(_entries.items(), key=lambda item: item[1][0])[: MAX_ENTRIES // 2]:
            _entries.pop(k, None)


def invalidate(*namespaces: str) -> None:
    with _lock:
        for namespace in namespaces:
            _versions[namespace] = _version(namespace) + 1


def clear() -> None:
    """Everything, every namespace. For tests."""
    with _lock:
        _entries.clear()
        _versions.clear()
